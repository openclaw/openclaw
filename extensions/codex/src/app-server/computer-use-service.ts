/** Provisions the macOS Computer Use service app for isolated Codex homes. */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import { resolveCodexAppServerUserHomeDir, type CodexAppServerStartOptions } from "./config.js";
import { resolveMacOSDesktopCodexComputerUseServiceAppCandidates } from "./desktop-app-paths.js";

const COMPUTER_USE_SERVICE_APP_NAME = "Codex Computer Use.app";
const COMPUTER_USE_SERVICE_INFO_PLIST_RELATIVE_PATH = path.join("Contents", "Info.plist");
const COMPUTER_USE_SERVICE_CODE_RESOURCES_RELATIVE_PATH = path.join(
  "Contents",
  "_CodeSignature",
  "CodeResources",
);
const COMPUTER_USE_CLIENT_RELATIVE_PATH = path.join(
  "Contents",
  "SharedSupport",
  "SkyComputerUseClient.app",
  "Contents",
  "MacOS",
  "SkyComputerUseClient",
);
const COMPUTER_USE_SERVICE_COPY_TIMEOUT_MS = 120_000;

export type CodexComputerUseServiceAppStatus = {
  status: "installed" | "already_installed" | "source_missing" | "unsupported";
  changed: boolean;
  targetPath?: string;
  sourcePath?: string;
  message: string;
};

type CopyServiceApp = (sourcePath: string, targetPath: string) => Promise<void>;
type MovePath = (sourcePath: string, targetPath: string) => Promise<void>;

type CodexComputerUseServiceAppState = {
  installs: Map<string, Promise<CodexComputerUseServiceAppStatus>>;
  fingerprints: Map<string, { fileIdentity: string; fingerprint: string }>;
};

const COMPUTER_USE_SERVICE_APP_STATE = Symbol.for("openclaw.codexComputerUseServiceAppState");

function getComputerUseServiceAppState(): CodexComputerUseServiceAppState {
  const globalState = globalThis as typeof globalThis & {
    [COMPUTER_USE_SERVICE_APP_STATE]?: CodexComputerUseServiceAppState;
  };
  globalState[COMPUTER_USE_SERVICE_APP_STATE] ??= {
    installs: new Map(),
    fingerprints: new Map(),
  };
  globalState[COMPUTER_USE_SERVICE_APP_STATE].fingerprints ??= new Map();
  return globalState[COMPUTER_USE_SERVICE_APP_STATE];
}

/** Returns the local Codex home used by a stdio app-server start. */
export function resolveCodexComputerUseServiceHome(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir?: string;
  config?: Parameters<typeof resolveDefaultAgentDir>[0];
}): string | undefined {
  if (params.startOptions.transport !== "stdio") {
    return undefined;
  }
  const configuredHome = params.startOptions.env?.CODEX_HOME?.trim();
  if (configuredHome) {
    return path.resolve(configuredHome);
  }
  if (params.startOptions.homeScope === "user") {
    return path.resolve(resolveCodexAppServerUserHomeDir());
  }
  const agentDir = params.agentDir ?? resolveDefaultAgentDir(params.config ?? {});
  return agentDir ? resolveCodexAppServerHomeDir(agentDir) : undefined;
}

/**
 * Copies the desktop-bundled service app into an isolated Codex home.
 *
 * New Computer Use plugin bundles launch this canonical per-CODEX_HOME copy;
 * plugin/install only installs the launcher and cannot create the service app.
 */
export async function ensureCodexComputerUseServiceApp(params: {
  codexHome: string;
  platform?: NodeJS.Platform;
  appServerCommand?: string;
  sourceAppCandidates?: readonly string[];
  copyServiceApp?: CopyServiceApp;
  movePath?: MovePath;
}): Promise<CodexComputerUseServiceAppStatus> {
  const platform = params.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      status: "unsupported",
      changed: false,
      message: `Computer Use service app provisioning is macOS-only, not ${platform}.`,
    };
  }
  const targetPath = path.join(
    path.resolve(params.codexHome),
    "computer-use",
    COMPUTER_USE_SERVICE_APP_NAME,
  );
  const state = getComputerUseServiceAppState();
  const existing = state.installs.get(targetPath);
  if (existing) {
    return await existing;
  }
  const install = ensureCodexComputerUseServiceAppOnce({
    ...params,
    targetPath,
    platform,
  });
  state.installs.set(targetPath, install);
  try {
    return await install;
  } finally {
    if (state.installs.get(targetPath) === install) {
      state.installs.delete(targetPath);
    }
  }
}

async function ensureCodexComputerUseServiceAppOnce(params: {
  targetPath: string;
  platform: NodeJS.Platform;
  appServerCommand?: string;
  sourceAppCandidates?: readonly string[];
  copyServiceApp?: CopyServiceApp;
  movePath?: MovePath;
}): Promise<CodexComputerUseServiceAppStatus> {
  const targetHasExecutableClient = await hasExecutableClient(params.targetPath);
  const sourceAppCandidates =
    params.sourceAppCandidates ??
    resolveMacOSDesktopCodexComputerUseServiceAppCandidates(
      params.platform,
      params.appServerCommand,
    );
  const sourcePath = await findUsableServiceApp(sourceAppCandidates);
  const targetFreshness = sourcePath
    ? await compareServiceAppFingerprint(sourcePath, params.targetPath)
    : "source_unknown";
  if (targetHasExecutableClient && (!sourcePath || targetFreshness !== "mismatch")) {
    return {
      status: "already_installed",
      changed: false,
      targetPath: params.targetPath,
      ...(sourcePath ? { sourcePath } : {}),
      message: `Computer Use service app is installed at ${params.targetPath}.`,
    };
  }
  if (!sourcePath) {
    return {
      status: "source_missing",
      changed: false,
      targetPath: params.targetPath,
      message: "No desktop-bundled Codex Computer Use service app was found.",
    };
  }

  const targetParent = path.dirname(params.targetPath);
  await fs.mkdir(targetParent, { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(targetParent, ".service-app.staging-"));
  const stagedPath = path.join(stagingRoot, COMPUTER_USE_SERVICE_APP_NAME);
  const backupPath = path.join(targetParent, `.service-app.backup-${process.pid}-${Date.now()}`);
  let backupCreated = false;
  try {
    await (params.copyServiceApp ?? copyServiceAppWithDitto)(sourcePath, stagedPath);
    if (!(await hasExecutableClient(stagedPath))) {
      throw new Error(`Copied Computer Use service app is incomplete at ${stagedPath}.`);
    }
    if ((await compareServiceAppFingerprint(sourcePath, stagedPath)) === "mismatch") {
      throw new Error(
        `Copied Computer Use service app does not match its source at ${stagedPath}.`,
      );
    }
    const targetExists = await fs.lstat(params.targetPath).then(
      () => true,
      () => false,
    );
    if (targetExists) {
      try {
        await (params.movePath ?? fs.rename)(params.targetPath, backupPath);
        backupCreated = true;
      } catch (error) {
        // Another OpenClaw process can win the target-to-backup race. Continue
        // only for that exact case; the staged install or winner is still safe.
        if (!isNodeErrorWithCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
    try {
      await (params.movePath ?? fs.rename)(stagedPath, params.targetPath);
    } catch (error) {
      if (await shouldPreserveUsableTarget(sourcePath, params.targetPath)) {
        if (backupCreated) {
          await fs.rm(backupPath, { recursive: true, force: true });
          backupCreated = false;
        }
        return {
          status: "already_installed",
          changed: false,
          targetPath: params.targetPath,
          sourcePath,
          message: `Computer Use service app is installed at ${params.targetPath}.`,
        };
      }
      if (backupCreated) {
        try {
          await fs.rename(backupPath, params.targetPath);
          backupCreated = false;
        } catch (restoreError) {
          throw new Error(
            `Failed to install Computer Use service app at ${params.targetPath} and restore its prior copy.`,
            { cause: restoreError },
          );
        }
      }
      throw error;
    }
    if (backupCreated) {
      await fs.rm(backupPath, { recursive: true, force: true });
    }
    return {
      status: "installed",
      changed: true,
      targetPath: params.targetPath,
      sourcePath,
      message: `Installed Computer Use service app at ${params.targetPath}.`,
    };
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function findUsableServiceApp(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await hasExecutableClient(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function hasExecutableClient(appPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(appPath, COMPUTER_USE_CLIENT_RELATIVE_PATH), fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function compareServiceAppFingerprint(
  sourcePath: string,
  targetPath: string,
): Promise<"match" | "mismatch" | "source_unknown"> {
  const sourceFingerprint = await readServiceAppFingerprint(sourcePath);
  if (!sourceFingerprint) {
    return "source_unknown";
  }
  const targetFingerprint = await readServiceAppFingerprint(targetPath);
  return targetFingerprint === sourceFingerprint ? "match" : "mismatch";
}

async function readServiceAppFingerprint(appPath: string): Promise<string | undefined> {
  try {
    const relativePaths = [
      COMPUTER_USE_SERVICE_INFO_PLIST_RELATIVE_PATH,
      COMPUTER_USE_SERVICE_CODE_RESOURCES_RELATIVE_PATH,
      COMPUTER_USE_CLIENT_RELATIVE_PATH,
    ];
    const stats = await Promise.all(
      relativePaths.map(async (relativePath) => await fs.stat(path.join(appPath, relativePath))),
    );
    const fileIdentity = stats
      .map(
        (stat, index) =>
          `${relativePaths[index]}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
      )
      .join("\0");
    const cacheKey = path.resolve(appPath);
    const fingerprintCache = getComputerUseServiceAppState().fingerprints;
    const cached = fingerprintCache.get(cacheKey);
    if (cached?.fileIdentity === fileIdentity) {
      return cached.fingerprint;
    }

    const hash = createHash("sha256");
    for (const relativePath of relativePaths) {
      hash.update(relativePath);
      hash.update("\0");
      hash.update(await fs.readFile(path.join(appPath, relativePath)));
      hash.update("\0");
    }
    const fingerprint = hash.digest("hex");
    fingerprintCache.set(cacheKey, { fileIdentity, fingerprint });
    return fingerprint;
  } catch {
    return undefined;
  }
}

async function shouldPreserveUsableTarget(
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  if (!(await hasExecutableClient(targetPath))) {
    return false;
  }
  return (await compareServiceAppFingerprint(sourcePath, targetPath)) !== "mismatch";
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function copyServiceAppWithDitto(sourcePath: string, targetPath: string): Promise<void> {
  await runExec("/usr/bin/ditto", ["--noqtn", sourcePath, targetPath], {
    logOutput: false,
    timeoutMs: COMPUTER_USE_SERVICE_COPY_TIMEOUT_MS,
  });
}
