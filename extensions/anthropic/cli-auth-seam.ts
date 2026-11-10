import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import {
  filterStringEntries,
  isRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import { CLAUDE_CLI_CLEAR_ENV } from "./cli-constants.js";

const CLAUDE_CLI_AUTH_TIMEOUT_MS = 10_000;

const CLAUDE_CLI_AUTH_METHODS = [
  "claude.ai",
  "api_key",
  "api_key_helper",
  "oauth_token",
  "third_party",
  "none",
] as const;

// Mirrors the CLI runner's child-env contract (src/agents/cli-runner/execute.ts): keys listed
// here survive the Claude clear list for native-login runs, so readiness must probe them too.
const CLI_BACKEND_PRESERVE_ENV = "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV";

function readPreservedCliEnv(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const raw = env[CLI_BACKEND_PRESERVE_ENV]?.trim();
  if (!raw) {
    return new Set();
  }
  if (raw.startsWith("[")) {
    try {
      return new Set(filterStringEntries(JSON.parse(raw)));
    } catch {
      return new Set();
    }
  }
  return new Set(raw.split(/[,\s]+/).filter(Boolean));
}

/** Ask Claude CLI whether its own login is usable without reading token material. */
export async function probeClaudeCliAuthStatus(params?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}) {
  const env = { ...(params?.env ?? process.env) };
  const preserved = readPreservedCliEnv(env);
  for (const name of CLAUDE_CLI_CLEAR_ENV) {
    if (!preserved.has(name)) {
      delete env[name];
    }
  }
  try {
    const program = resolveWindowsSpawnProgram({
      command: params?.command ?? "claude",
      env,
      packageName: "@anthropic-ai/claude-code",
    });
    const invocation = materializeWindowsSpawnProgram(program, ["auth", "status", "--json"]);
    const result = await runUtf8CommandWithTimeout([invocation.command, ...invocation.argv], {
      baseEnv: env,
      maxOutputBytes: 64 * 1024,
      maxCombinedOutputBytes: 64 * 1024,
      terminateOnOutputLimit: true,
      timeoutMs: CLAUDE_CLI_AUTH_TIMEOUT_MS,
      signal: params?.signal,
      killProcessTree: true,
    });
    params?.signal?.throwIfAborted();
    if (result.termination === "timeout") {
      return { status: "timeout" as const, timeoutMs: CLAUDE_CLI_AUTH_TIMEOUT_MS };
    }
    if (result.termination !== "exit" || result.code === null) {
      return { status: "unreadable" as const };
    }
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isRecord(parsed) || typeof parsed.loggedIn !== "boolean") {
      return { status: "unreadable" as const };
    }
    if (!parsed.loggedIn) {
      return { status: "missing" as const };
    }
    if (result.code !== 0) {
      return { status: "unreadable" as const };
    }
    const authMethod = CLAUDE_CLI_AUTH_METHODS.find((method) => method === parsed.authMethod);
    const email = authMethod === "claude.ai" ? normalizeOptionalString(parsed.email) : undefined;
    return {
      status: "available" as const,
      ...(authMethod ? { authMethod } : {}),
      ...(email && email.length <= 320 && !/[\r\n]/u.test(email) ? { email } : {}),
    };
  } catch (error) {
    params?.signal?.throwIfAborted();
    // A host without the executable cannot run native login; only an installed CLI is inconclusive.
    return {
      status:
        isRecord(error) && error.code === "ENOENT"
          ? ("not-installed" as const)
          : ("unreadable" as const),
    };
  }
}
