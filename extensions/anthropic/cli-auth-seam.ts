import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { CLAUDE_CLI_CLEAR_ENV } from "./cli-constants.js";

export type ClaudeCliNativeLogin =
  | { readiness: "configured" | "unknown" }
  | { readiness: "missing"; message: string };

async function observeFile(file: string): Promise<"present" | "absent" | "unknown"> {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 0 ? "present" : "absent";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? "absent"
      : "unknown";
  }
}

/** Observe login sources, never their secrets. Claude alone verifies and refreshes its login. */
export async function observeClaudeCliNativeLogin(params?: {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<ClaudeCliNativeLogin> {
  params?.signal?.throwIfAborted();
  const env = { ...(params?.env ?? process.env) };
  for (const name of CLAUDE_CLI_CLEAR_ENV) {
    delete env[name];
  }
  const home =
    env.HOME || (process.platform === "win32" ? env.USERPROFILE : undefined) || homedir();
  const configDir = env.CLAUDE_CONFIG_DIR
    ? path.resolve(env.CLAUDE_CONFIG_DIR)
    : path.join(home, ".claude");
  const storageSelector = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR;
  const storageDir = storageSelector ? path.resolve(storageSelector) : path.join(home, ".claude");
  const [credential, settings, account] = await Promise.all([
    observeFile(path.join(storageDir, ".credentials.json")),
    observeFile(path.join(configDir, "settings.json")),
    observeFile(
      env.CLAUDE_CONFIG_DIR
        ? path.join(configDir, ".claude.json")
        : path.join(home, ".claude.json"),
    ),
  ]);
  params?.signal?.throwIfAborted();
  // A zero/absent expiry is not logout. Do not parse or borrow Claude's token material.
  if (credential === "present") {
    return { readiness: "configured" };
  }
  let keychain: "present" | "absent" | "unknown" = "absent";
  if (process.platform === "darwin") {
    const suffix = storageSelector
      ? `-${createHash("sha256").update(storageSelector.normalize("NFC")).digest("hex").slice(0, 8)}`
      : "";
    try {
      const username = env.USER || userInfo().username;
      const keychainAccount = /^[a-zA-Z0-9._-]+$/u.test(username) ? username : "claude-code-user";
      // Without -w/-g, security reads attributes, not the ACL-protected password.
      const result = await runUtf8CommandWithTimeout(
        [
          "/usr/bin/security",
          "find-generic-password",
          "-a",
          keychainAccount,
          "-s",
          `Claude Code-credentials${suffix}`,
        ],
        { baseEnv: env, timeoutMs: 2_000, maxOutputBytes: 16 * 1024, signal: params?.signal },
      );
      keychain =
        result.termination !== "exit"
          ? "unknown"
          : result.code === 0
            ? "present"
            : result.code === 44
              ? "absent"
              : "unknown";
    } catch {
      params?.signal?.throwIfAborted();
      keychain = "unknown";
    }
  }
  params?.signal?.throwIfAborted();
  if (keychain === "present") {
    return { readiness: "configured" };
  }
  // User settings can supply apiKeyHelper, env auth, or an external API backend.
  // Metadata cannot disprove those logins; do not read potentially secret settings.
  if (
    credential === "unknown" ||
    keychain === "unknown" ||
    settings !== "absent" ||
    account !== "absent"
  ) {
    return { readiness: "unknown" };
  }
  const selectors = ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"].map((name) =>
    env[name] === undefined ? `${name} unset` : `${name}=${JSON.stringify(env[name])}`,
  );
  return {
    readiness: "missing",
    message: `Claude CLI has no native login in ${configDir}. Run claude auth login as the Gateway user with ${selectors.join(" and ")}, then refresh Models.`,
  };
}
