import fs from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { coerceErrorMessage, toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import { isPathInside, isPathStrictlyInside } from "openclaw/plugin-sdk/file-access-runtime";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import { appendRegularFile } from "openclaw/plugin-sdk/security-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { createQaArtifactRunId } from "./artifact-run-id.js";
import type { QaProviderMode } from "./model-selection.js";
import { resolveQaForwardedLiveEnv, resolveQaLiveProviderConfigPath } from "./providers/env.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE, getQaProvider } from "./providers/index.js";
import type { RuntimeId } from "./runtime-id.js";
import { shellQuote } from "./shell-quote.js";

const MULTIPASS_MOUNTED_REPO_PATH = "/workspace/openclaw-host";
const MULTIPASS_GUEST_REPO_PATH = "/workspace/openclaw";
const MULTIPASS_GUEST_CODEX_HOME_PATH = "/workspace/openclaw-codex-home";
const MULTIPASS_GUEST_PACKAGES = [
  "build-essential",
  "ca-certificates",
  "curl",
  "pkg-config",
  "python3",
  "rsync",
  "xz-utils",
] as const;
const MULTIPASS_REPO_SYNC_EXCLUDES = [
  ".git",
  "node_modules",
  ".artifacts",
  ".tmp",
  ".turbo",
  "coverage",
  "*.heapsnapshot",
] as const;
const MULTIPASS_EXEC_MAX_BUFFER = 64 * 1024 * 1024;
const MULTIPASS_GUEST_RUN_TIMEOUT_MS = 60 * 60 * 1000;

const qaMultipassDefaultResources = {
  image: "lts",
  cpus: 2,
  memory: "4G",
  disk: "24G",
} as const;

type ExecFileError = Error & {
  code?: string;
};

type ExecFileOptions = {
  timeoutMs?: number;
};

type QaMultipassPlan = ReturnType<typeof createQaMultipassPlan>;

function createOutputStamp() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replace("T", "-");
}

async function execFileAsync(file: string, args: string[], options: ExecFileOptions = {}) {
  try {
    return await runExec(file, args, {
      logOutput: false,
      maxBuffer: MULTIPASS_EXEC_MAX_BUFFER,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    const output = error as { code?: string; stdout?: unknown; stderr?: unknown };
    const stdout = typeof output.stdout === "string" ? output.stdout : "";
    const stderr = typeof output.stderr === "string" ? output.stderr : "";
    const message = stderr.trim() || stdout.trim() || (error instanceof Error ? error.message : "");
    const wrappedError = new Error(message || "Multipass command failed", {
      cause: error,
    }) as ExecFileError;
    wrappedError.code = output.code;
    throw wrappedError;
  }
}

function resolveExistingPath(value: string) {
  let currentPath = value;
  while (!fs.existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`unable to resolve existing path for ${value}`);
    }
    currentPath = parentPath;
  }
  return currentPath;
}

function resolveMountedOutputPath(repoRoot: string, hostPath: string) {
  const relativePath = path.relative(repoRoot, hostPath);
  if (!isPathStrictlyInside(repoRoot, hostPath)) {
    throw new Error(
      `qa suite --runner multipass requires --output-dir to stay under the repo root (${repoRoot}), got ${hostPath}.`,
    );
  }

  const realRepoRoot = fs.realpathSync.native(repoRoot);
  const existingHostPath = resolveExistingPath(hostPath);
  const realExistingHostPath = fs.realpathSync.native(existingHostPath);
  if (!isPathInside(realRepoRoot, realExistingHostPath)) {
    throw new Error(
      `qa suite --runner multipass requires --output-dir to stay under the repo root (${repoRoot}), got ${hostPath}.`,
    );
  }

  return path.posix.join(MULTIPASS_MOUNTED_REPO_PATH, ...relativePath.split(path.sep));
}

function resolvePnpmVersion(repoRoot: string) {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    packageManager?: string;
  };
  const packageManager = packageJson.packageManager ?? "";
  const match = /^pnpm@(.+)$/.exec(packageManager);
  if (!match?.[1]) {
    throw new Error(`unable to resolve pnpm version from packageManager in ${packageJsonPath}`);
  }
  const version = match[1];
  if (!/^[0-9A-Za-z.+_-]+$/u.test(version)) {
    throw new Error(`unsupported pnpm version in packageManager: ${version}`);
  }
  return version;
}

function resolveMultipassInstallHint() {
  if (process.platform === "darwin") {
    return "brew install --cask multipass";
  }
  if (process.platform === "win32") {
    return "winget install Canonical.Multipass";
  }
  if (process.platform === "linux") {
    return "sudo snap install multipass";
  }
  return "https://multipass.run/install";
}

function createQaMultipassOutputDir(repoRoot: string) {
  return path.join(repoRoot, ".artifacts", "qa-e2e", `multipass-${createOutputStamp()}`);
}

function createQaMultipassPlan(params: {
  repoRoot: string;
  outputDir?: string;
  transportId?: string;
  providerMode?: QaProviderMode;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  thinkingDefault?: string;
  allowFailures?: boolean;
  failFast?: boolean;
  scenarioIds?: string[];
  concurrency?: number;
  runtimePair?: [RuntimeId, RuntimeId];
  channelDriver?: string;
  channelId?: string;
  enabledPluginIds?: string[];
  image?: string;
  cpus?: number;
  memory?: string;
  disk?: string;
}) {
  const outputDir = params.outputDir ?? createQaMultipassOutputDir(params.repoRoot);
  const scenarioIds = uniqueStrings(params.scenarioIds ?? []);
  const enabledPluginIds = uniqueStrings(
    (params.enabledPluginIds ?? []).map((pluginId) => pluginId.trim()).filter(Boolean),
  );
  const transportId = params.transportId?.trim() || "qa-channel";
  const providerMode = params.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE;
  const provider = getQaProvider(providerMode);
  const forwardedEnv = provider.kind === "live" ? resolveQaForwardedLiveEnv() : {};
  const hostCodexHomePath = forwardedEnv.CODEX_HOME;
  const liveProviderConfig =
    provider.kind === "live" ? resolveQaLiveProviderConfigPath() : undefined;
  const hostLiveProviderConfigPath =
    liveProviderConfig && fs.existsSync(liveProviderConfig.path)
      ? liveProviderConfig.path
      : undefined;
  const vmName = `openclaw-qa-${createQaArtifactRunId()}`;
  const guestMountedOutputDir = resolveMountedOutputPath(params.repoRoot, outputDir);
  const relativeOutputDir = path.posix.relative(MULTIPASS_MOUNTED_REPO_PATH, guestMountedOutputDir);
  const guestOutputDir = path.posix.join(MULTIPASS_GUEST_REPO_PATH, relativeOutputDir);
  const qaCommand = [
    "pnpm",
    "openclaw",
    "qa",
    "suite",
    "--transport",
    transportId,
    "--provider-mode",
    providerMode,
    "--output-dir",
    relativeOutputDir,
    ...(params.primaryModel ? ["--model", params.primaryModel] : []),
    ...(params.alternateModel ? ["--alt-model", params.alternateModel] : []),
    ...(params.fastMode ? ["--fast"] : []),
    ...(params.thinkingDefault ? ["--thinking", params.thinkingDefault] : []),
    ...(params.allowFailures ? ["--allow-failures"] : []),
    ...(params.failFast ? ["--fail-fast"] : []),
    ...(params.concurrency ? ["--concurrency", String(params.concurrency)] : []),
    ...(params.runtimePair ? ["--runtime-pair", params.runtimePair.join(",")] : []),
    ...(params.channelDriver && params.channelId
      ? ["--channel-driver", params.channelDriver, "--channel", params.channelId]
      : []),
    ...enabledPluginIds.flatMap((pluginId) => ["--enable-plugin", pluginId]),
    ...scenarioIds.flatMap((scenarioId) => ["--scenario", scenarioId]),
  ];

  return {
    repoRoot: params.repoRoot,
    outputDir,
    reportPath: path.join(outputDir, "qa-suite-report.md"),
    summaryPath: path.join(outputDir, "qa-suite-summary.json"),
    hostLogPath: path.join(outputDir, "multipass-host.log"),
    hostBootstrapLogPath: path.join(outputDir, "multipass-guest-bootstrap.log"),
    hostGuestScriptPath: path.join(outputDir, "multipass-guest-run.sh"),
    vmName,
    image: params.image ?? qaMultipassDefaultResources.image,
    cpus: params.cpus ?? qaMultipassDefaultResources.cpus,
    memory: params.memory ?? qaMultipassDefaultResources.memory,
    disk: params.disk ?? qaMultipassDefaultResources.disk,
    pnpmVersion: resolvePnpmVersion(params.repoRoot),
    scenarioIds,
    forwardedEnv,
    hostCodexHomePath,
    guestCodexHomePath: hostCodexHomePath ? MULTIPASS_GUEST_CODEX_HOME_PATH : undefined,
    hostLiveProviderConfigPath,
    guestLiveProviderConfigPath: hostLiveProviderConfigPath
      ? `/tmp/${vmName}-live-provider-config.json`
      : undefined,
    guestMountedRepoPath: MULTIPASS_MOUNTED_REPO_PATH,
    guestRepoPath: MULTIPASS_GUEST_REPO_PATH,
    guestMountedOutputDir,
    guestOutputDir,
    guestScriptPath: `/tmp/${vmName}-qa-suite.sh`,
    guestBootstrapLogPath: `/tmp/${vmName}-bootstrap.log`,
    qaCommand,
  };
}

function renderQaMultipassGuestScript(plan: QaMultipassPlan, redactSecrets = false) {
  const nodeVersionCheck = [
    `import { isSupportedOpenClawNodeVersion } from ${JSON.stringify(
      `file://${plan.guestMountedRepoPath}/node-version.mjs`,
    )};`,
    "process.exit(isSupportedOpenClawNodeVersion(process.versions.node) ? 0 : 1);",
  ].join(" ");
  const rsyncCommand = [
    "rsync -a --delete",
    ...MULTIPASS_REPO_SYNC_EXCLUDES.flatMap((value) => ["--exclude", shellQuote(value)]),
    shellQuote(`${plan.guestMountedRepoPath}/`),
    shellQuote(`${plan.guestRepoPath}/`),
  ].join(" ");
  const qaCommand = [
    ...Object.entries(plan.forwardedEnv)
      .filter(
        ([key]) =>
          key !== "CODEX_HOME" &&
          key !== "OPENCLAW_CONFIG_PATH" &&
          key !== "OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH",
      )
      .map(([key, value]) => `${key}=${shellQuote(redactSecrets ? "<redacted>" : value)}`),
    ...(plan.guestCodexHomePath ? [`CODEX_HOME=${shellQuote(plan.guestCodexHomePath)}`] : []),
    ...(plan.guestLiveProviderConfigPath
      ? [
          `OPENCLAW_CONFIG_PATH=${shellQuote(plan.guestLiveProviderConfigPath)}`,
          `OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH=${shellQuote(plan.guestLiveProviderConfigPath)}`,
        ]
      : []),
    plan.qaCommand.map(shellQuote).join(" "),
  ].join(" ");

  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "trap 'status=$?; echo \"guest failure (exit ${status})\" >&2; exit ${status}' ERR",
    "",
    "export DEBIAN_FRONTEND=noninteractive",
    `BOOTSTRAP_LOG=${shellQuote(plan.guestBootstrapLogPath)}`,
    ': > "$BOOTSTRAP_LOG"',
    "",
    "ensure_guest_packages() {",
    '  sudo -E apt-get update >>"$BOOTSTRAP_LOG" 2>&1',
    "  sudo -E apt-get install -y \\",
    ...MULTIPASS_GUEST_PACKAGES.map((value, index) =>
      index === MULTIPASS_GUEST_PACKAGES.length - 1
        ? `    ${value} >>"$BOOTSTRAP_LOG" 2>&1`
        : `    ${value} \\`,
    ),
    "}",
    "",
    "ensure_node() {",
    // The mounted launcher contract is dependency-free; Node 24 also supplies
    // Corepack, which newer supported Node releases may omit.
    `  if command -v corepack >/dev/null && node --input-type=module -e ${shellQuote(nodeVersionCheck)} 2>/dev/null; then`,
    "    return 0",
    "  fi",
    "  local node_arch",
    '  case "$(uname -m)" in',
    '    x86_64) node_arch="x64" ;;',
    '    aarch64|arm64) node_arch="arm64" ;;',
    '    *) echo "unsupported guest architecture for node bootstrap: $(uname -m)" >&2; return 1 ;;',
    "  esac",
    "  local node_tmp_dir tarball_name extract_dir base_url",
    '  node_tmp_dir="$(mktemp -d)"',
    "  trap 'rm -rf \"${node_tmp_dir}\"' RETURN",
    '  base_url="https://nodejs.org/dist/latest-v24.x"',
    '  curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 --retry-max-time 120 "${base_url}/SHASUMS256.txt" -o "${node_tmp_dir}/SHASUMS256.txt" >>"$BOOTSTRAP_LOG" 2>&1',
    '  tarball_name="$(awk \'/linux-\'"${node_arch}"\'\\.tar\\.xz$/ { print $2; exit }\' "${node_tmp_dir}/SHASUMS256.txt")"',
    '  [ -n "${tarball_name}" ] || { echo "unable to resolve node tarball for ${node_arch}" >&2; return 1; }',
    '  curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 --retry-max-time 120 "${base_url}/${tarball_name}" -o "${node_tmp_dir}/${tarball_name}" >>"$BOOTSTRAP_LOG" 2>&1',
    '  (cd "${node_tmp_dir}" && grep " ${tarball_name}$" SHASUMS256.txt | sha256sum -c -) >>"$BOOTSTRAP_LOG" 2>&1',
    '  extract_dir="${tarball_name%.tar.xz}"',
    '  sudo mkdir -p /usr/local/lib/nodejs >>"$BOOTSTRAP_LOG" 2>&1',
    '  sudo rm -rf "/usr/local/lib/nodejs/${extract_dir}" >>"$BOOTSTRAP_LOG" 2>&1',
    '  sudo tar -xJf "${node_tmp_dir}/${tarball_name}" -C /usr/local/lib/nodejs >>"$BOOTSTRAP_LOG" 2>&1',
    '  sudo ln -sf "/usr/local/lib/nodejs/${extract_dir}/bin/node" /usr/local/bin/node >>"$BOOTSTRAP_LOG" 2>&1',
    '  sudo ln -sf "/usr/local/lib/nodejs/${extract_dir}/bin/npm" /usr/local/bin/npm >>"$BOOTSTRAP_LOG" 2>&1',
    '  sudo ln -sf "/usr/local/lib/nodejs/${extract_dir}/bin/npx" /usr/local/bin/npx >>"$BOOTSTRAP_LOG" 2>&1',
    '  sudo ln -sf "/usr/local/lib/nodejs/${extract_dir}/bin/corepack" /usr/local/bin/corepack >>"$BOOTSTRAP_LOG" 2>&1',
    '  export PATH="/usr/local/bin:$PATH"',
    "  hash -r",
    `  node --input-type=module -e ${shellQuote(nodeVersionCheck)}`,
    "}",
    "",
    "ensure_pnpm() {",
    '  sudo env PATH="/usr/local/bin:/usr/bin:/bin" corepack enable >>"$BOOTSTRAP_LOG" 2>&1',
    `  sudo env PATH="/usr/local/bin:/usr/bin:/bin" corepack prepare ${shellQuote(`pnpm@${plan.pnpmVersion}`)} --activate >>"$BOOTSTRAP_LOG" 2>&1`,
    "}",
    "",
    'command -v sudo >/dev/null || { echo "missing sudo in guest" >&2; exit 1; }',
    "ensure_guest_packages",
    "ensure_node",
    "ensure_pnpm",
    'command -v node >/dev/null || { echo "missing node after guest bootstrap" >&2; exit 1; }',
    'command -v pnpm >/dev/null || { echo "missing pnpm after guest bootstrap" >&2; exit 1; }',
    'command -v rsync >/dev/null || { echo "missing rsync after guest bootstrap" >&2; exit 1; }',
    "",
    `mkdir -p ${shellQuote(path.posix.dirname(plan.guestRepoPath))}`,
    `rm -rf ${shellQuote(plan.guestRepoPath)}`,
    `mkdir -p ${shellQuote(plan.guestRepoPath)}`,
    rsyncCommand,
    `cd ${shellQuote(plan.guestRepoPath)}`,
    'pnpm install --frozen-lockfile >>"$BOOTSTRAP_LOG" 2>&1',
    'pnpm build >>"$BOOTSTRAP_LOG" 2>&1',
    `mkdir -p ${shellQuote(plan.guestOutputDir)}`,
    // Bind after building so dependency installation and compilation stay guest-local.
    `sudo mount --bind ${shellQuote(plan.guestMountedOutputDir)} ${shellQuote(plan.guestOutputDir)}`,
    qaCommand,
    "",
  ];
  return lines.join("\n");
}

async function appendMultipassLog(logPath: string, message: string) {
  await appendRegularFile({ filePath: logPath, content: message });
}

async function runMultipassCommand(logPath: string, args: string[], options: ExecFileOptions = {}) {
  await appendMultipassLog(logPath, `$ ${["multipass", ...args].join(" ")}\n`);
  const result = await execFileAsync("multipass", args, options);
  for (const output of [result.stdout, result.stderr]) {
    if (output.trim()) {
      await appendMultipassLog(logPath, `${output.trim()}\n`);
    }
  }
  await appendMultipassLog(logPath, "\n");
  return result;
}

async function retryMultipassCommand(
  logPath: string,
  args: string[],
  retryLabel: string,
  attempts: number,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await runMultipassCommand(logPath, args);
      return;
    } catch (error) {
      lastError = error;
      await appendMultipassLog(
        logPath,
        `${retryLabel} retry ${attempt}/${attempts}: ${coerceErrorMessage(error)}\n\n`,
      );
      if (attempt < attempts) {
        await sleep(2_000);
      }
    }
  }
  throw toStringifiedError(lastError);
}

async function mountPath(logPath: string, hostPath: string, guestPath: string, retryLabel: string) {
  await retryMultipassCommand(logPath, ["mount", hostPath, guestPath], retryLabel, 5);
}

async function transferLiveProviderConfig(plan: QaMultipassPlan) {
  if (!plan.hostLiveProviderConfigPath || !plan.guestLiveProviderConfigPath) {
    return;
  }
  await runMultipassCommand(plan.hostLogPath, [
    "transfer",
    plan.hostLiveProviderConfigPath,
    `${plan.vmName}:${plan.guestLiveProviderConfigPath}`,
  ]);
}

async function tryCopyGuestBootstrapLog(plan: QaMultipassPlan) {
  try {
    await runMultipassCommand(plan.hostLogPath, [
      "transfer",
      `${plan.vmName}:${plan.guestBootstrapLogPath}`,
      plan.hostBootstrapLogPath,
    ]);
  } catch (error) {
    await appendMultipassLog(
      plan.hostLogPath,
      `bootstrap log transfer skipped: ${coerceErrorMessage(error)}\n\n`,
    );
  }
}

export async function runQaMultipass(
  params: Omit<Parameters<typeof createQaMultipassPlan>[0], "thinkingDefault">,
) {
  const plan = createQaMultipassPlan(params);
  await mkdir(plan.outputDir, { recursive: true });
  await writeFile(
    plan.hostLogPath,
    `# OpenClaw QA Multipass host log\nvmName=${plan.vmName}\noutputDir=${plan.outputDir}\n\n`,
    "utf8",
  );
  await writeFile(plan.hostGuestScriptPath, renderQaMultipassGuestScript(plan, true), {
    encoding: "utf8",
    mode: 0o600,
  });

  try {
    await execFileAsync("multipass", ["version"]);
  } catch (error) {
    if ((error as ExecFileError).code !== "ENOENT") {
      throw new Error(`Unable to verify Multipass availability: ${coerceErrorMessage(error)}.`, {
        cause: error,
      });
    }
    throw new Error(
      `Multipass is not installed on this host. Install it with '${resolveMultipassInstallHint()}', then rerun 'pnpm openclaw qa suite --runner multipass'.`,
      { cause: error },
    );
  }

  const hostTransferDirPath = await fs.promises.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), `${plan.vmName}-qa-suite-`),
  );
  const hostTransferScriptPath = path.join(hostTransferDirPath, "guest-run.sh");
  await writeFile(hostTransferScriptPath, renderQaMultipassGuestScript(plan), {
    encoding: "utf8",
    mode: 0o600,
  });

  let launched = false;
  try {
    await runMultipassCommand(plan.hostLogPath, [
      "launch",
      "--name",
      plan.vmName,
      "--cpus",
      String(plan.cpus),
      "--memory",
      plan.memory,
      "--disk",
      plan.disk,
      plan.image,
    ]);
    launched = true;
    await retryMultipassCommand(
      plan.hostLogPath,
      ["exec", plan.vmName, "--", "bash", "-lc", "echo guest-ready"],
      "guest-ready",
      12,
    );
    await mountPath(
      plan.hostLogPath,
      plan.repoRoot,
      `${plan.vmName}:${MULTIPASS_MOUNTED_REPO_PATH}`,
      "mount",
    );
    if (plan.hostCodexHomePath) {
      await mountPath(
        plan.hostLogPath,
        plan.hostCodexHomePath,
        `${plan.vmName}:${MULTIPASS_GUEST_CODEX_HOME_PATH}`,
        "codex-home mount",
      );
    }
    await transferLiveProviderConfig(plan);
    await runMultipassCommand(plan.hostLogPath, [
      "transfer",
      hostTransferScriptPath,
      `${plan.vmName}:${plan.guestScriptPath}`,
    ]);
    await runMultipassCommand(plan.hostLogPath, [
      "exec",
      plan.vmName,
      "--",
      "chmod",
      "+x",
      plan.guestScriptPath,
    ]);
    await runMultipassCommand(plan.hostLogPath, ["exec", plan.vmName, "--", plan.guestScriptPath], {
      timeoutMs: MULTIPASS_GUEST_RUN_TIMEOUT_MS,
    });
    await tryCopyGuestBootstrapLog(plan);
  } catch (error) {
    if (launched) {
      await tryCopyGuestBootstrapLog(plan);
    }
    throw new Error(
      `QA Multipass run failed: ${coerceErrorMessage(error)}. See ${plan.hostLogPath}.`,
      { cause: error },
    );
  } finally {
    await fs.promises.rm(hostTransferDirPath, { recursive: true, force: true });
    if (launched) {
      try {
        await runMultipassCommand(plan.hostLogPath, ["delete", "--purge", plan.vmName]);
      } catch (error) {
        await appendMultipassLog(
          plan.hostLogPath,
          `cleanup error: ${coerceErrorMessage(error)}\n\n`,
        );
      }
    }
  }

  await access(plan.reportPath);
  await access(plan.summaryPath);

  return {
    outputDir: plan.outputDir,
    reportPath: plan.reportPath,
    summaryPath: plan.summaryPath,
    hostLogPath: plan.hostLogPath,
    bootstrapLogPath: plan.hostBootstrapLogPath,
    guestScriptPath: plan.hostGuestScriptPath,
    vmName: plan.vmName,
    scenarioIds: plan.scenarioIds,
  };
}
