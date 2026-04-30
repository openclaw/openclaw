import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup-runtime";

export const GEMINI_CLI_NPM_PACKAGE = "@google/gemini-cli";
export const GEMINI_CLI_BINARY_NAME = "gemini";

const DETECT_TIMEOUT_MS = 5_000;

export type GeminiCliDetectResult = {
  found: boolean;
  version?: string;
  error?: string;
};

type SpawnSyncImpl = (
  command: string,
  args: ReadonlyArray<string>,
  options?: SpawnSyncOptions,
) => ReturnType<typeof spawnSync>;

export type GeminiCliInstallDeps = {
  spawnSync: SpawnSyncImpl;
  platform: NodeJS.Platform;
};

const defaultDeps: GeminiCliInstallDeps = {
  spawnSync,
  platform: process.platform,
};

function resolveNpmCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function detectGeminiCli(deps: Partial<GeminiCliInstallDeps> = {}): GeminiCliDetectResult {
  const { spawnSync: spawnImpl } = { ...defaultDeps, ...deps };
  try {
    const result = spawnImpl(GEMINI_CLI_BINARY_NAME, ["--version"], {
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

export function installGeminiCliViaNpm(
  runtime: Pick<RuntimeEnv, "log" | "error">,
  deps: Partial<GeminiCliInstallDeps> = {},
): boolean {
  const { spawnSync: spawnImpl, platform } = { ...defaultDeps, ...deps };
  const npm = resolveNpmCommand(platform);
  runtime.log(`Running: ${npm} install -g ${GEMINI_CLI_NPM_PACKAGE}`);
  try {
    const result = spawnImpl(npm, ["install", "-g", GEMINI_CLI_NPM_PACKAGE], {
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) {
      runtime.error(`Gemini CLI install failed: ${result.error.message}`);
      return false;
    }
    if (result.status !== 0) {
      runtime.error(`Gemini CLI install exited with code ${result.status ?? "?"}.`);
      return false;
    }
    return true;
  } catch (err) {
    runtime.error(`Gemini CLI install failed: ${(err as Error).message}`);
    return false;
  }
}

export function runGeminiCliLogin(
  runtime: Pick<RuntimeEnv, "log" | "error">,
  deps: Partial<GeminiCliInstallDeps> = {},
): boolean {
  const { spawnSync: spawnImpl } = { ...defaultDeps, ...deps };
  runtime.log(`Running: ${GEMINI_CLI_BINARY_NAME} (interactive sign-in flow)`);
  try {
    const result = spawnImpl(GEMINI_CLI_BINARY_NAME, [], {
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) {
      runtime.error(`Gemini CLI sign-in failed to launch: ${result.error.message}`);
      return false;
    }
    return result.status === 0;
  } catch (err) {
    runtime.error(`Gemini CLI sign-in failed: ${(err as Error).message}`);
    return false;
  }
}

export type EnsureGeminiCliReadyResult =
  | { ok: true; version?: string }
  | { ok: false; reason: string };

export async function ensureGeminiCliInstalled(params: {
  prompter: WizardPrompter;
  runtime: Pick<RuntimeEnv, "log" | "error">;
  deps?: Partial<GeminiCliInstallDeps>;
}): Promise<EnsureGeminiCliReadyResult> {
  const initial = detectGeminiCli(params.deps);
  if (initial.found) {
    return { ok: true, ...(initial.version ? { version: initial.version } : {}) };
  }

  await params.prompter.note(
    [
      `Gemini CLI (${GEMINI_CLI_NPM_PACKAGE}) is not installed on this host.`,
      "OpenClaw needs it to run Gemini through your subscription in headless mode.",
    ].join("\n"),
    "Gemini CLI",
  );

  const shouldInstall = await params.prompter.confirm({
    message: `Install Gemini CLI now? (npm install -g ${GEMINI_CLI_NPM_PACKAGE})`,
    initialValue: true,
  });
  if (!shouldInstall) {
    return {
      ok: false,
      reason: [
        "Gemini CLI install was declined.",
        `Install it manually with: npm install -g ${GEMINI_CLI_NPM_PACKAGE}`,
        "Then re-run this setup.",
      ].join("\n"),
    };
  }

  const installed = installGeminiCliViaNpm(params.runtime, params.deps);
  if (!installed) {
    return {
      ok: false,
      reason: [
        "Gemini CLI install failed.",
        "Check the npm output above and try again, or install manually:",
        `  npm install -g ${GEMINI_CLI_NPM_PACKAGE}`,
      ].join("\n"),
    };
  }

  const verify = detectGeminiCli(params.deps);
  if (!verify.found) {
    return {
      ok: false,
      reason: [
        "Gemini CLI install completed but the `gemini` binary is not on PATH.",
        "Restart your terminal (so PATH refreshes) or check your npm global bin directory, then re-run this setup.",
      ].join("\n"),
    };
  }
  return { ok: true, ...(verify.version ? { version: verify.version } : {}) };
}
