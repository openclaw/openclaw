import path from "node:path";
import { normalizeUniqueStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { appendCodexGitConfigParameters } from "./config-utils.js";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

const GIT_CONFIG_PARAMETERS = "GIT_CONFIG_PARAMETERS";

function matchesGitConfigParameters(pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "iu").test(
    GIT_CONFIG_PARAMETERS,
  );
}

/** Retain native policy beneath request overrides before applying host-owned values. */
export function mergeCodexNativeShellEnvironment(
  config: JsonObject | undefined,
  nativePolicy: unknown,
): JsonObject | undefined {
  // config/read serializes absent optional fields as null. Request overrides
  // convert null to an empty TOML string, which is invalid for policy fields.
  return isJsonObject(nativePolicy)
    ? mergeCodexThreadConfigs(
        {
          shell_environment_policy: Object.fromEntries(
            Object.entries(nativePolicy).filter(([, value]) => value !== null),
          ),
        },
        config,
      )
    : config;
}

/** Applies host-selected values and any required login-shell restriction last. */
export function applyCodexManagedShellEnvironment(
  config: JsonObject,
  environment: Readonly<Record<string, string>> | undefined,
  disableLoginShell = false,
  pathPrepend?: readonly string[],
  gitConfigParameters?: string,
): JsonObject {
  const hasEnvironment = environment !== undefined && Object.keys(environment).length > 0;
  if (!hasEnvironment && !gitConfigParameters) {
    return disableLoginShell ? { ...config, allow_login_shell: false } : config;
  }
  const current = isJsonObject(config.shell_environment_policy)
    ? config.shell_environment_policy
    : {};
  const currentSet = isJsonObject(current.set) ? current.set : {};
  const managedEnvironment = { ...environment };
  const includeOnly = Array.isArray(current.include_only)
    ? current.include_only.filter((entry): entry is string => typeof entry === "string")
    : [];
  const filters = isJsonObject(current.filters) ? current.filters : undefined;
  if (gitConfigParameters) {
    const include = filters
      ? Object.keys(filters).filter((pattern) => filters[pattern] === "include")
      : includeOnly;
    const exclude = filters
      ? Object.keys(filters).filter((pattern) => filters[pattern] === "exclude")
      : Array.isArray(current.exclude)
        ? current.exclude.filter((entry): entry is string => typeof entry === "string")
        : [];
    const aliases = Object.keys(currentSet).filter(
      (key) =>
        key === GIT_CONFIG_PARAMETERS ||
        (process.platform === "win32" && key.toUpperCase() === GIT_CONFIG_PARAMETERS),
    );
    const authoredKey = aliases.includes(GIT_CONFIG_PARAMETERS)
      ? GIT_CONFIG_PARAMETERS
      : aliases[0];
    // Codex excludes inherited variables before policy.set, then applies include-only
    // to both. Keep admitted inheritance private: Git parameters can carry credentials.
    const includesParameters = include.length === 0 || include.some(matchesGitConfigParameters);
    const inheritsParameters =
      current.inherit !== "none" &&
      current.inherit !== "core" &&
      !exclude.some(matchesGitConfigParameters) &&
      includesParameters;
    if (authoredKey !== undefined || !inheritsParameters) {
      const base =
        authoredKey !== undefined && includesParameters ? currentSet[authoredKey] : undefined;
      const composed = appendCodexGitConfigParameters(
        typeof base === "string" ? base : undefined,
        gitConfigParameters,
      );
      for (const name of [GIT_CONFIG_PARAMETERS, ...aliases]) {
        managedEnvironment[name] = composed;
      }
    }
  }
  // PATH is a prefix policy, unlike identity values. Keep an explicit native or
  // request PATH (including an empty one) beneath the host prefix.
  if (pathPrepend?.length) {
    for (const key of Object.keys(environment ?? {})) {
      if (key.toUpperCase() !== "PATH") {
        continue;
      }
      const aliases = Object.keys(currentSet).filter(
        (name) => name === key || (process.platform === "win32" && name.toUpperCase() === "PATH"),
      );
      const authoredKey = aliases.includes(key) ? key : aliases[0];
      if (authoredKey !== undefined && typeof currentSet[authoredKey] === "string") {
        const merged = normalizeUniqueStringEntries([
          ...pathPrepend,
          ...currentSet[authoredKey].split(path.delimiter),
        ]).join(path.delimiter);
        // Native TOML layers can retain another Windows casing. Give every alias
        // the same value so environment-map iteration cannot restore a stale PATH.
        for (const name of [key, ...aliases]) {
          managedEnvironment[name] = merged;
        }
      }
    }
  }
  const names = Object.keys(managedEnvironment).toSorted();
  const hasIncludeFilter = filters && Object.values(filters).includes("include");
  const managedFilterNames = new Set(names.map((name) => name.toLowerCase()));
  const managedConfig = {
    ...config,
    shell_environment_policy: {
      ...current,
      ...(hasEnvironment ? { experimental_use_profile: false } : {}),
      set: { ...currentSet, ...managedEnvironment },
      ...(filters
        ? hasIncludeFilter
          ? {
              filters: {
                // Codex rejects case-equivalent patterns before merging layers.
                // Replace managed aliases without changing unrelated wildcard filters.
                ...Object.fromEntries(
                  Object.entries(filters).filter(
                    ([name]) => !managedFilterNames.has(name.toLowerCase()),
                  ),
                ),
                ...Object.fromEntries([...managedFilterNames].map((name) => [name, "include"])),
              },
            }
          : {}
        : includeOnly.length > 0
          ? { include_only: [...new Set([...includeOnly, ...names])] }
          : {}),
    },
  };
  return disableLoginShell ? { ...managedConfig, allow_login_shell: false } : managedConfig;
}
