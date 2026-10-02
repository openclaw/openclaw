import path from "node:path";
import { normalizeUniqueStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

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
): JsonObject {
  if (!environment || Object.keys(environment).length === 0) {
    return disableLoginShell ? { ...config, allow_login_shell: false } : config;
  }
  const current = isJsonObject(config.shell_environment_policy)
    ? config.shell_environment_policy
    : {};
  const currentSet = isJsonObject(current.set) ? current.set : {};
  const managedEnvironment = { ...environment };
  // PATH is a prefix policy, unlike identity values. Keep an explicit native or
  // request PATH (including an empty one) beneath the host prefix.
  if (pathPrepend?.length) {
    for (const key of Object.keys(environment)) {
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
  const includeOnly = Array.isArray(current.include_only)
    ? current.include_only.filter((entry): entry is string => typeof entry === "string")
    : [];
  const filters = isJsonObject(current.filters) ? current.filters : undefined;
  const hasIncludeFilter = filters && Object.values(filters).includes("include");
  const managedFilterNames = new Set(names.map((name) => name.toLowerCase()));
  const managedConfig = {
    ...config,
    shell_environment_policy: {
      ...current,
      experimental_use_profile: false,
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
