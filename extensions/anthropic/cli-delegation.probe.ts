import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClaudeCliStatus } from "./cli-delegation.types.js";

const execFileAsync = promisify(execFile);

const UNAUTH_PATTERNS = ["not logged in", "login required", "run `claude login`"];
const SUB_KEYS = ["subscriptionType", "subscription_type", "planType", "plan_type"];
const AUTH_METHOD_KEYS = ["authMethod", "auth_method"];
const VALID_AUTH_METHODS = ["apiKey", "subscription"] as const;
type AuthMethod = (typeof VALID_AUTH_METHODS)[number];

/**
 * The auth-only slice of ClaudeCliStatus (with installed omitted).
 * Discriminates on `authenticated` just like the outer union does.
 */
type ClaudeAuthResult =
  | { authenticated: false; reason: string }
  | { authenticated: true; subscriptionType?: string; authMethod?: "apiKey" | "subscription" };

/**
 * Recursively walk an unknown JSON structure looking for a key match.
 */
export function findDeep(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.includes(k) && typeof v === "string" && v.trim().length > 0) {
      return v.trim();
    }
    const deep = findDeep(v, keys);
    if (deep) return deep;
  }
  return undefined;
}

/**
 * Parse the output of `claude auth status` into an auth result.
 * Exported for direct testing of the parsing logic.
 */
export function parseClaudeAuthOutput(stdout: string): ClaudeAuthResult {
  const lower = stdout.toLowerCase();

  // Check for unauthenticated signals
  if (UNAUTH_PATTERNS.some((p) => lower.includes(p))) {
    return { authenticated: false, reason: "not_logged_in" };
  }

  // Try to parse as JSON for subscription info
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Non-JSON output but no unauthenticated signal = likely OK
    return { authenticated: true };
  }

  const rawMethod = findDeep(parsed, AUTH_METHOD_KEYS);
  const authMethod =
    rawMethod && (VALID_AUTH_METHODS as readonly string[]).includes(rawMethod)
      ? (rawMethod as AuthMethod)
      : undefined;

  return {
    authenticated: true,
    subscriptionType: findDeep(parsed, SUB_KEYS),
    authMethod,
  };
}

/**
 * Probe the Claude CLI for installation and authentication status.
 *
 * Tier 1: Spawns `claude --version` and `claude auth status` via execFile.
 * Does not use the Agent SDK — just the CLI binary directly.
 */
export async function probeClaudeCliStatus(binaryPath = "claude"): Promise<ClaudeCliStatus> {
  // 1. Check installation
  try {
    await execFileAsync(binaryPath, ["--version"], { timeout: 10_000 });
  } catch (err) {
    return { installed: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // 2. Check auth status
  let stdout: string;
  try {
    const result = await execFileAsync(binaryPath, ["auth", "status"], { timeout: 15_000 });
    stdout = result.stdout;
  } catch {
    return { installed: true, authenticated: false, reason: "status_check_failed" };
  }

  const authResult = parseClaudeAuthOutput(stdout);
  if (!authResult.authenticated) {
    return { installed: true, authenticated: false, reason: authResult.reason };
  }
  return {
    installed: true,
    authenticated: true,
    subscriptionType: authResult.subscriptionType,
    authMethod: authResult.authMethod,
  };
}

/**
 * Zero-cost SDK probe: spawns claude binary, reads initializationResult(),
 * then immediately aborts. No API tokens consumed.
 *
 * Use as a fallback when `claude auth status` doesn't include subscription info.
 */
export async function probeClaudeCapabilities(
  binaryPath = "claude",
): Promise<{ subscriptionType?: string } | null> {
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const abort = new AbortController();
    const timeoutId = setTimeout(() => abort.abort(), 30_000);

    try {
      const q = query({
        prompt: ".",
        options: {
          persistSession: false,
          pathToClaudeCodeExecutable: binaryPath,
          abortController: abort,
          maxTurns: 0,
          settingSources: [],
          allowedTools: [],
          stderr: () => {},
        },
      });

      const init = await q.initializationResult();
      abort.abort();
      q.close();
      return { subscriptionType: init.account?.subscriptionType };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return null;
  }
}
