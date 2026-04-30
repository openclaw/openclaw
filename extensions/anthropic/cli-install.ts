import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup-runtime";

export const CLAUDE_CLI_NPM_PACKAGE = "@anthropic-ai/claude-code";
export const CLAUDE_CLI_BINARY_NAME = "claude";
export const CLAUDE_CLI_LOGIN_ARGS = ["auth", "login"] as const;

const DETECT_TIMEOUT_MS = 5_000;

export type ClaudeCliDetectResult = {
  found: boolean;
  version?: string;
  error?: string;
};

type SpawnSyncImpl = (
  command: string,
  args: ReadonlyArray<string>,
  options?: SpawnSyncOptions,
) => ReturnType<typeof spawnSync>;

export type ClaudeCliInstallDeps = {
  spawnSync: SpawnSyncImpl;
  platform: NodeJS.Platform;
};

const defaultDeps: ClaudeCliInstallDeps = {
  spawnSync,
  platform: process.platform,
};

function resolveNpmCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function detectClaudeCli(deps: Partial<ClaudeCliInstallDeps> = {}): ClaudeCliDetectResult {
  const { spawnSync: spawnImpl } = { ...defaultDeps, ...deps };
  try {
    const result = spawnImpl(CLAUDE_CLI_BINARY_NAME, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DETECT_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
    });
    if (result.error) {
      return { found: false, error: result.error.message };
    }
    if (result.status === 0) {
      const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
      return { found: true, ...(stdout ? { version: stdout } : {}) };
    }
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    return { found: false, error: stderr || `exit ${result.status ?? "?"}` };
  } catch (err) {
    return { found: false, error: (err as Error).message };
  }
}

export function installClaudeCliViaNpm(
  runtime: Pick<RuntimeEnv, "log" | "error">,
  deps: Partial<ClaudeCliInstallDeps> = {},
): boolean {
  const { spawnSync: spawnImpl, platform } = { ...defaultDeps, ...deps };
  const npm = resolveNpmCommand(platform);
  runtime.log(`Running: ${npm} install -g ${CLAUDE_CLI_NPM_PACKAGE}`);
  try {
    const result = spawnImpl(npm, ["install", "-g", CLAUDE_CLI_NPM_PACKAGE], {
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) {
      runtime.error(`Claude CLI install failed: ${result.error.message}`);
      return false;
    }
    if (result.status !== 0) {
      runtime.error(`Claude CLI install exited with code ${result.status ?? "?"}.`);
      return false;
    }
    return true;
  } catch (err) {
    runtime.error(`Claude CLI install failed: ${(err as Error).message}`);
    return false;
  }
}

export function runClaudeCliLogin(
  runtime: Pick<RuntimeEnv, "log" | "error">,
  deps: Partial<ClaudeCliInstallDeps> = {},
): boolean {
  const { spawnSync: spawnImpl } = { ...defaultDeps, ...deps };
  const args = [...CLAUDE_CLI_LOGIN_ARGS];
  runtime.log(`Running: ${CLAUDE_CLI_BINARY_NAME} ${args.join(" ")}`);
  try {
    const result = spawnImpl(CLAUDE_CLI_BINARY_NAME, args, {
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) {
      runtime.error(`Claude CLI sign-in failed to launch: ${result.error.message}`);
      return false;
    }
    return result.status === 0;
  } catch (err) {
    runtime.error(`Claude CLI sign-in failed: ${(err as Error).message}`);
    return false;
  }
}

export type EnsureClaudeCliReadyResult =
  | { ok: true; version?: string }
  | { ok: false; reason: string };

export async function ensureClaudeCliInstalled(params: {
  prompter: WizardPrompter;
  runtime: Pick<RuntimeEnv, "log" | "error">;
  deps?: Partial<ClaudeCliInstallDeps>;
}): Promise<EnsureClaudeCliReadyResult> {
  const initial = detectClaudeCli(params.deps);
  if (initial.found) {
    return { ok: true, ...(initial.version ? { version: initial.version } : {}) };
  }

  await params.prompter.note(
    [
      `Claude CLI (${CLAUDE_CLI_NPM_PACKAGE}) is not installed on this host.`,
      "OpenClaw needs it to run Claude through your subscription in headless mode.",
    ].join("\n"),
    "Claude CLI",
  );

  const shouldInstall = await params.prompter.confirm({
    message: `Install Claude CLI now? (npm install -g ${CLAUDE_CLI_NPM_PACKAGE})`,
    initialValue: true,
  });
  if (!shouldInstall) {
    return {
      ok: false,
      reason: [
        "Claude CLI install was declined.",
        `Install it manually with: npm install -g ${CLAUDE_CLI_NPM_PACKAGE}`,
        "Then re-run this setup.",
      ].join("\n"),
    };
  }

  const installed = installClaudeCliViaNpm(params.runtime, params.deps);
  if (!installed) {
    return {
      ok: false,
      reason: [
        "Claude CLI install failed.",
        "Check the npm output above and try again, or install manually:",
        `  npm install -g ${CLAUDE_CLI_NPM_PACKAGE}`,
      ].join("\n"),
    };
  }

  const verify = detectClaudeCli(params.deps);
  if (!verify.found) {
    return {
      ok: false,
      reason: [
        "Claude CLI install completed but the `claude` binary is not on PATH.",
        "Restart your terminal (so PATH refreshes) or check your npm global bin directory, then re-run this setup.",
      ].join("\n"),
    };
  }
  return { ok: true, ...(verify.version ? { version: verify.version } : {}) };
}
