#!/usr/bin/env -S pnpm tsx
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { posixAgentWorkspaceScript } from "./agent-workspace.ts";
import {
  die,
  currentRunningSnapshotInfo,
  makeTempDir,
  parseBoolEnv,
  readPositiveIntEnv,
  modelProviderConfigBatchJson,
  posixCodexPlatformPackageRepairFunction,
  posixProviderOnlyPluginIsolationScript,
  repoRoot,
  resolveParallelsModelTimeoutSeconds,
  resolveLatestVersion,
  resolveProviderAuth,
  resolveSnapshot,
  run,
  say,
  shouldSkipSnapshotRestore,
  shellQuote,
  validateSnapshotRestoreMode,
  warn,
  withProgressOnStderr,
  writeJson,
  writeSummaryMarkdown,
  type PackageArtifact,
  type ProviderAuth,
  type SnapshotInfo,
} from "./common.ts";
import { LinuxGuest } from "./guest-transports.ts";
import { ensureVmRunning, resolveUbuntuVmName } from "./parallels-vm.ts";
import { PhaseRunner } from "./phase-runner.ts";
import {
  buildCommonSmokeSummary,
  expectedPackageBuildCommit,
  expectedPackageTargetVersion,
  ensureSmokeGuestRuntime,
  extractLastOpenClawVersion,
  installSmokeRuntimeCompanions,
  npmRegistryEnv,
  packAndServeSmokeArtifact,
  printSmokeTargetSummary,
  posixAgentTurnScript,
  posixStopGatewayScript,
  parseSmokeCliArgs,
  SmokeRunController,
  smokeDefaultOptions,
  smokeDefaultStatus,
  type SmokeCliOptions,
} from "./smoke-common.ts";

// Restored Ubuntu snapshots may immediately run package maintenance for hours.
// Reuse an existing downloader before touching apt, then bound the fallback.
const APT_LOCK_RETRY_SECONDS = 900;
const BOOTSTRAP_TIMEOUT_SECONDS = 1200;

interface LinuxOptions extends SmokeCliOptions {
  vmNameExplicit: boolean;
}

const defaultOptions = (): LinuxOptions => ({
  ...smokeDefaultOptions,
  apiKeyEnv: undefined,
  hostPort: 18427,
  installUrl: "https://openclaw.ai/install.sh",
  snapshotHint: "fresh",
  vmName: "Ubuntu 26.04",
  vmNameExplicit: false,
});

function usage(): string {
  return `Usage: bash scripts/e2e/parallels-linux-smoke.sh [options]

Options:
  --vm <name>                Parallels VM name. Default: "Ubuntu 26.04"
                             Falls back to the closest Ubuntu VM when omitted and unavailable.
  --snapshot-hint <name>     Snapshot name substring/fuzzy match. Default: "fresh"
  --mode <fresh|upgrade|both>
  --provider <openai|anthropic|minimax>
                             Provider auth/model lane. Default: openai
  --model <provider/model>    Override the model used for the agent-turn smoke.
  --api-key-env <var>        Host env var name for provider API key.
  --openai-api-key-env <var> Alias for --api-key-env (backward compatible)
  --install-url <url>        Installer URL for latest release. Default: https://openclaw.ai/install.sh
  --host-port <port>         Host HTTP port for current-main tgz. Default: 18427
  --host-ip <ip>             Override Parallels host IP.
  --latest-version <ver>     Override npm latest version lookup.
  --install-version <ver>    Pin site-installer version/dist-tag for the baseline lane.
  --target-package-spec <npm-spec>
                             Install this npm package tarball instead of packing current main.
  --npm-registry <url>       Registry used for target package installs.
  --keep-server              Leave temp host HTTP server running.
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.
`;
}

export function parseArgs(argv: string[]): LinuxOptions {
  const options = defaultOptions();
  return parseSmokeCliArgs(argv, options, {
    usage,
    valueHandlers: {
      "--vm": (parsed, value) => {
        parsed.vmName = value;
        parsed.vmNameExplicit = true;
      },
    },
  });
}

class LinuxSmoke extends SmokeRunController<LinuxOptions> {
  private auth: ProviderAuth;
  private disableBonjour = parseBoolEnv(process.env.OPENCLAW_PARALLELS_LINUX_DISABLE_BONJOUR);
  private agentTimeoutSeconds = readPositiveIntEnv(
    "OPENCLAW_PARALLELS_LINUX_AGENT_TIMEOUT_S",
    1500,
  );
  private artifact: PackageArtifact | null = null;
  private latestVersion = "";
  private snapshot!: SnapshotInfo;
  private phases!: PhaseRunner;
  private guest!: LinuxGuest;
  private guestEnv: Record<string, string> = {};

  protected status = {
    ...smokeDefaultStatus,
    daemon: "systemd-user-unavailable",
  };

  constructor(options: LinuxOptions) {
    super(options);
    this.auth = resolveProviderAuth({
      apiKeyEnv: options.apiKeyEnv,
      modelId: options.modelId,
      provider: options.provider,
    });
  }

  async run(): Promise<void> {
    this.runDir = await makeTempDir("openclaw-parallels-linux.");
    this.phases = new PhaseRunner(this.runDir);
    this.tgzDir = await makeTempDir("openclaw-parallels-linux-tgz.");
    try {
      this.options.vmName = resolveUbuntuVmName(this.options.vmName, this.options.vmNameExplicit);
      validateSnapshotRestoreMode(this.options.mode, "Linux smoke");
      this.snapshot = shouldSkipSnapshotRestore()
        ? currentRunningSnapshotInfo(this.options.vmName)
        : resolveSnapshot(this.options.vmName, this.options.snapshotHint);
      this.guest = new LinuxGuest(this.options.vmName, this.phases, () => this.guestEnv);
      this.latestVersion = resolveLatestVersion(this.options.latestVersion);
      await this.prepareHost(
        defaultOptions().hostPort,
        this.latestVersion,
        this.snapshot,
        this.options.vmName,
      );

      [this.artifact, this.server, this.hostPort] = await packAndServeSmokeArtifact(
        this.tgzDir,
        this.options.targetPackageSpec,
        this.hostIp,
        this.hostPort,
        this.artifactLabel(),
        false,
        this.options.provider,
      );

      await this.runLanesAndFinish();
    } finally {
      await this.cleanupArtifacts();
    }
  }

  private artifactLabel(): string {
    return this.options.targetPackageSpec ? "target package tgz" : "current main tgz";
  }

  protected runFreshLane(): Promise<void> {
    return this.runInstallLane("fresh");
  }

  protected runUpgradeLane(): Promise<void> {
    return this.runInstallLane("upgrade");
  }

  private async runInstallLane(lane: "fresh" | "upgrade"): Promise<void> {
    await this.phases.phase(`${lane}.restore-snapshot`, 180, () => this.restoreSnapshot());
    await this.phases.phase(`${lane}.bootstrap-guest`, BOOTSTRAP_TIMEOUT_SECONDS, () =>
      this.bootstrapGuest(),
    );
    await this.phases.phase(`${lane}.reset-state`, 180, () => this.resetState());
    await this.phases.phase(`${lane}.preflight`, 90, () => this.logGuestPreflight());
    if (lane === "fresh") {
      await this.phases.phase("fresh.ensure-runtime", 420, () =>
        ensureSmokeGuestRuntime({
          runShell: (script) => this.guest.bash(script),
          bootstrap: () => this.installLatestRelease(),
        }),
      );
    } else {
      await this.phases.phase("upgrade.install-latest", 420, () => this.installLatestRelease());
      this.status.latestInstalledVersion = await this.extractLastVersion("upgrade.install-latest");
      await this.phases.phase("upgrade.verify-latest-version", 90, () =>
        this.verifyVersionContains(this.latestVersion),
      );
    }
    await this.phases.phase(`${lane}.install-main`, 420, () =>
      this.installMainTgz(`openclaw-main-${lane}.tgz`),
    );
    this.status[`${lane}Version`] = await this.extractLastVersion(`${lane}.install-main`);
    await this.phases.phase(`${lane}.verify-main-version`, 90, () => this.verifyTargetVersion());
    if (lane === "fresh") {
      await this.phases.phase("fresh.install-companions", 600, () =>
        installSmokeRuntimeCompanions({
          provider: this.options.provider,
          readCli: (args) => this.guest.exec(["openclaw", ...args]),
          installCli: (args) => {
            this.guest.exec(["openclaw", ...args]);
          },
        }),
      );
      await this.phases.phase("fresh.onboard-ref", 420, () => this.runRefOnboard());
    }
    await this.phases.phase(`${lane}.inject-bad-plugin`, 90, () => this.injectBadPluginFixture());
    if (lane === "upgrade") {
      await this.phases.phase("upgrade.onboard-ref", 420, () => this.runRefOnboard());
    }
    await this.phases.phase(`${lane}.gateway-start`, 240, () => this.startGatewayBackground());
    await this.phases.phase(`${lane}.bad-plugin-diagnostic`, 90, () =>
      this.verifyBadPluginDiagnostic(lane),
    );
    await this.phases.phase(`${lane}.gateway-status`, 240, () => this.verifyGatewayStatus());
    this.status[`${lane}Gateway`] = "pass";
    await this.phases.phase(`${lane}.first-local-agent-turn`, this.agentTimeoutSeconds, () =>
      this.verifyLocalTurn(),
    );
    this.status[`${lane}Agent`] = "pass";
  }

  private logGuestPreflight(): void {
    this.guest.bash(String.raw`set -euo pipefail
printf 'preflight.user=%s\n' "$(whoami)"
printf 'preflight.home=%s\n' "$HOME"
printf 'preflight.path=%s\n' "$PATH"
printf 'preflight.umask=%s\n' "$(umask)"
printf 'preflight.npmRoot=%s\n' "$(npm root -g 2>/dev/null || true)"`);
  }

  private waitForGuestReady(timeoutSeconds = 180): void {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (
        run("prlctl", ["exec", this.options.vmName, "/usr/bin/env", "HOME=/root", "/bin/true"], {
          check: false,
          timeoutMs: this.phases.remainingTimeoutMs(),
        }).status === 0
      ) {
        return;
      }
      run("sleep", ["2"]);
    }
    die(`guest did not become ready in ${this.options.vmName}`);
  }

  private restoreSnapshot(): void {
    // A restored baseline must resolve public packages, not the previous candidate registry.
    this.guestEnv = {};
    if (shouldSkipSnapshotRestore()) {
      say(`Skip snapshot restore; using current running VM ${this.options.vmName}`);
      this.waitForGuestReady();
      return;
    }
    say(`Restore snapshot ${this.options.snapshotHint} (${this.snapshot.id})`);
    run("prlctl", ["snapshot-switch", this.options.vmName, "--id", this.snapshot.id], {
      timeoutMs: this.phases.remainingTimeoutMs(),
    });
    ensureVmRunning(this.options.vmName, 180, {
      probeTimeoutMs: () => this.phases.remainingTimeoutMs(30_000),
      transitionTimeoutMs: () => this.phases.remainingTimeoutMs(120_000),
    });
    this.waitForGuestReady();
  }

  private bootstrapGuest(): void {
    const hostNow = `@${Math.floor(Date.now() / 1000)}`;
    this.guest.exec(["date", "-u", "-s", hostNow]);
    this.guest.exec(["hwclock", "--systohc"], { check: false });
    this.guest.exec(["timedatectl", "set-ntp", "true"], { check: false });
    this.guest.exec(["systemctl", "restart", "systemd-timesyncd"], { check: false });
    this.guest.bash(`
set -e
if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
  exit 0
fi
deadline=$((SECONDS + ${APT_LOCK_RETRY_SECONDS}))
run_apt_with_lock_retry() {
  local output status
  while true; do
    if output="$("$@" 2>&1)"; then
      status=0
    else
      status=$?
    fi
    printf '%s\n' "$output"
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    case "$output" in
      *"Could not get lock"*|*"Unable to acquire the dpkg frontend lock"*|*"Unable to lock directory"*)
        if [ "$SECONDS" -ge "$deadline" ]; then
          printf 'Timed out waiting for Ubuntu package maintenance locks\n' >&2
          return "$status"
        fi
        sleep 5
        ;;
      *)
        return "$status"
        ;;
    esac
  done
}
run_apt_with_lock_retry apt-get -o Acquire::Check-Date=false -o DPkg::Lock::Timeout=30 update
run_apt_with_lock_retry apt-get -o DPkg::Lock::Timeout=30 install -y curl ca-certificates`);
  }

  private resetState(): void {
    this.guest.bash(String.raw`set -euo pipefail
pkill -f '[o]penclaw.*gateway run' >/dev/null 2>&1 || true
pkill -f '[o]penclaw-gateway' >/dev/null 2>&1 || true
pkill -f '[o]penclaw.mjs gateway' >/dev/null 2>&1 || true
npm uninstall -g openclaw >/dev/null 2>&1 || true
rm -rf /root/.openclaw /root/.npm/_cacache
rm -f /tmp/openclaw-parallels-linux-gateway.log`);
  }

  private installLatestRelease(): void {
    this.downloadGuestFile(this.options.installUrl, "/tmp/openclaw-install.sh");
    this.guest.exec([
      "/usr/bin/env",
      "OPENCLAW_NO_ONBOARD=1",
      "bash",
      "/tmp/openclaw-install.sh",
      ...(this.options.installVersion ? ["--version", this.options.installVersion] : []),
      "--no-onboard",
    ]);
    this.guest.exec(["openclaw", "--version"]);
  }

  private downloadGuestFile(url: string, outputPath: string): void {
    this.guest.bash(`
set -e
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 ${shellQuote(
    url,
  )} -o ${shellQuote(outputPath)}
else
  wget -q --timeout=10 --read-timeout=120 --tries=3 -O ${shellQuote(outputPath)} ${shellQuote(url)}
fi`);
  }

  private installMainTgz(tempName: string): void {
    if (!this.artifact || !this.server) {
      die("package artifact/server missing");
    }
    this.guestEnv = npmRegistryEnv(this.options.npmRegistry ?? this.server.registry?.url);
    const tgzUrl = this.server.urlFor(this.artifact.path);
    this.downloadGuestFile(tgzUrl, `/tmp/${tempName}`);
    this.guest.exec(["npm", "install", "-g", `/tmp/${tempName}`, "--no-fund", "--no-audit"]);
    this.guest.exec(["openclaw", "--version"]);
  }

  private async verifyTargetVersion(): Promise<void> {
    if (!this.artifact) {
      die("package artifact missing");
    }
    if (this.options.targetPackageSpec) {
      this.verifyVersionContains(await expectedPackageTargetVersion(this.artifact));
      return;
    }
    this.verifyVersionContains(await expectedPackageBuildCommit(this.artifact));
  }

  private verifyVersionContains(needle: string): void {
    const version = this.guest.exec(["openclaw", "--version"]);
    if (!version.includes(needle)) {
      throw new Error(`version mismatch: expected substring ${needle}`);
    }
  }

  private runRefOnboard(): void {
    this.guest.exec([
      "/usr/bin/env",
      `${this.auth.apiKeyEnv}=${this.auth.apiKeyValue}`,
      "openclaw",
      "onboard",
      "--non-interactive",
      "--mode",
      "local",
      "--auth-choice",
      this.auth.authChoice,
      ...(this.auth.tokenProvider ? ["--token-provider", this.auth.tokenProvider] : []),
      "--secret-input-mode",
      "ref",
      "--gateway-port",
      "18789",
      "--gateway-bind",
      "loopback",
      "--skip-skills",
      "--skip-health",
      "--accept-risk",
      "--json",
    ]);
  }

  private injectBadPluginFixture(): void {
    this.guest.bash(String.raw`set -euo pipefail
plugin_dir=/root/.openclaw/test-bad-plugin
mkdir -p "$plugin_dir"
cat >"$plugin_dir/package.json" <<'JSON'
{"name":"@openclaw/test-bad-plugin","version":"1.0.0","openclaw":{"extensions":["./index.cjs"],"setupEntry":"./setup-entry.cjs"}}
JSON
cat >"$plugin_dir/openclaw.plugin.json" <<'JSON'
{"id":"test-bad-plugin","configSchema":{"type":"object","additionalProperties":false,"properties":{}},"channels":["test-bad-plugin"]}
JSON
cat >"$plugin_dir/index.cjs" <<'JS'
module.exports = { id: "test-bad-plugin", register() {} };
JS
cat >"$plugin_dir/setup-entry.cjs" <<'JS'
module.exports = {
  kind: "bundled-channel-setup-entry",
  loadSetupPlugin() {
    throw new Error("boom: bad plugin smoke fixture");
  },
};
JS
python3 - <<'PY'
import json
from pathlib import Path
config_path = Path("/root/.openclaw/openclaw.json")
config = json.loads(config_path.read_text()) if config_path.exists() else {}
plugins = config.setdefault("plugins", {})
load = plugins.setdefault("load", {})
paths = load.setdefault("paths", [])
plugin_dir = "/root/.openclaw/test-bad-plugin"
if plugin_dir not in paths:
    paths.append(plugin_dir)
allow = plugins.get("allow")
if not isinstance(allow, list):
    allow = plugins["allow"] = ["openai"]
for plugin_id in ("test-bad-plugin", "openai"):
    if plugin_id not in allow:
        allow.append(plugin_id)
config_path.write_text(json.dumps(config, indent=2) + "\n")
PY`);
  }

  private startGatewayBackground(): void {
    const bonjourEnv = this.disableBonjour ? " OPENCLAW_DISABLE_BONJOUR=1" : "";
    this.guest.bash(
      String.raw`pkill -f "openclaw gateway run" >/dev/null 2>&1 || true
rm -f /tmp/openclaw-parallels-linux-gateway.log
setsid sh -lc ` +
        shellQuote(
          `exec env OPENCLAW_HOME=/root OPENCLAW_STATE_DIR=/root/.openclaw OPENCLAW_CONFIG_PATH=/root/.openclaw/openclaw.json OPENCLAW_ALLOW_ROOT=1${bonjourEnv} ${this.auth.apiKeyEnv}=${shellQuote(
            this.auth.apiKeyValue,
          )} openclaw gateway run --bind loopback --port 18789 --force >/tmp/openclaw-parallels-linux-gateway.log 2>&1`,
        ) +
        String.raw` >/dev/null 2>&1 < /dev/null &`,
    );
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (this.showGatewayStatusCompat()) {
        return;
      }
      run("sleep", ["2"]);
    }
    throw new Error("gateway did not become ready");
  }

  private showGatewayStatusCompat(): boolean {
    const help = this.guest.exec(["openclaw", "gateway", "status", "--help"], { check: false });
    const args = help.includes("--require-rpc")
      ? ["openclaw", "gateway", "status", "--deep", "--require-rpc"]
      : ["openclaw", "gateway", "status", "--deep"];
    const result = this.guest.run(args, { check: false });
    return result.status === 0;
  }

  private verifyGatewayStatus(): void {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const result = this.guest.run(
        ["openclaw", "gateway", "status", "--deep", "--require-rpc", "--timeout", "15000"],
        { check: false },
      );
      if (result.status === 0) {
        return;
      }
      if (attempt < 8) {
        warn(`gateway-status retry ${attempt}`);
        run("sleep", ["5"]);
      }
    }
    throw new Error("gateway status did not become RPC-ready");
  }

  private async verifyBadPluginDiagnostic(lane: "fresh" | "upgrade"): Promise<void> {
    const warning =
      "channel plugin manifest declares test-bad-plugin without channelConfigs metadata";
    const gatewayStartLog = await readFile(
      path.join(this.runDir, `${lane}.gateway-start.log`),
      "utf8",
    );
    if (!gatewayStartLog.includes(warning)) {
      throw new Error(`bad plugin diagnostic missing: ${warning}`);
    }
    this.phases.append(warning);
    this.guest.bash(String.raw`set -euo pipefail
python3 - <<'PY'
import json
from pathlib import Path
config_path = Path("/root/.openclaw/openclaw.json")
config = json.loads(config_path.read_text()) if config_path.exists() else {}
plugins = config.setdefault("plugins", {})
load = plugins.setdefault("load", {})
paths = load.get("paths")
if isinstance(paths, list):
    load["paths"] = [path for path in paths if path != "/root/.openclaw/test-bad-plugin"]
allow = plugins.get("allow")
if isinstance(allow, list):
    plugins["allow"] = [plugin_id for plugin_id in allow if plugin_id != "test-bad-plugin"]
config_path.write_text(json.dumps(config, indent=2) + "\n")
PY
rm -rf /root/.openclaw/test-bad-plugin`);
  }

  private restrictAgentTurnPlugins(): void {
    this.guest.bash(
      posixProviderOnlyPluginIsolationScript({
        fallbackPluginId: this.options.provider,
        modelId: this.auth.modelId,
      }),
    );
  }

  private verifyLocalTurn(): void {
    this.guest.bash(`set -euo pipefail\n${posixStopGatewayScript()}`);
    this.guest.exec(["openclaw", "models", "set", this.auth.modelId]);
    const modelProviderConfigBatch = modelProviderConfigBatchJson(this.auth.modelId, "linux");
    if (modelProviderConfigBatch) {
      this.guest.bash(`provider_config_batch="$(mktemp)"
cat >"$provider_config_batch" <<'JSON'
${modelProviderConfigBatch}
JSON
openclaw config set --batch-file "$provider_config_batch" --strict-json
rm -f "$provider_config_batch"`);
    }
    this.guest.exec([
      "openclaw",
      "config",
      "set",
      "agents.defaults.skipBootstrap",
      "true",
      "--strict-json",
    ]);
    this.guest.exec(["openclaw", "config", "set", "tools.profile", "minimal"]);
    this.restrictAgentTurnPlugins();
    this.guest.bash(posixAgentWorkspaceScript("Parallels Linux smoke test assistant."));
    this.guest.bash(
      `${posixCodexPlatformPackageRepairFunction()}
${posixAgentTurnScript({
  command: `/usr/bin/env OPENCLAW_ALLOW_ROOT=1 ${shellQuote(`${this.auth.apiKeyEnv}=${this.auth.apiKeyValue}`)} openclaw agent --local --agent main --session-id "$session_id" --message ${shellQuote(
    "Reply with exact ASCII text OK only.",
  )} --thinking off --timeout ${resolveParallelsModelTimeoutSeconds("linux")} --json`,
  sessionIdExpression: '"parallels-linux-smoke"',
  retrySessionIdExpression: '"parallels-linux-smoke-retry-$attempt"',
  printOutput: "cat",
})}`,
    );
  }

  private async extractLastVersion(phaseId: string): Promise<string> {
    return await extractLastOpenClawVersion(
      this.runDir,
      phaseId,
      /(OpenClaw [^\r\n]+ \([0-9a-f]{7,}\))/g,
    );
  }

  protected async writeSummary(): Promise<string> {
    const summaryPath = path.join(this.runDir, "summary.json");
    const summary = {
      daemon: this.status.daemon,
      ...buildCommonSmokeSummary({
        artifact: this.artifact,
        latestVersion: this.latestVersion,
        options: this.options,
        runDir: this.runDir,
        snapshot: this.snapshot,
        status: this.status,
        vmName: this.options.vmName,
      }),
    };
    await writeJson(summaryPath, summary);
    await writeSummaryMarkdown({
      lines: [
        `- vm: ${summary.vm}`,
        `- target: ${summary.targetPackageSpec || "current main"}`,
        `- daemon: ${summary.daemon}`,
        `- fresh: ${summary.freshMain.status} ${summary.freshMain.version}`,
        `- fresh gateway/agent: ${summary.freshMain.gateway}/${summary.freshMain.agent}`,
        `- upgrade: ${summary.upgrade.status} ${summary.upgrade.mainVersion}`,
        `- logs: ${summary.runDir}`,
      ],
      summaryPath,
      title: "Linux Parallels Smoke",
    });
    return summaryPath;
  }

  protected printSummary(summaryPath: string): void {
    process.stdout.write("\nSummary:\n");
    printSmokeTargetSummary(this.options);
    process.stdout.write(`  daemon: ${this.status.daemon}\n`);
    process.stdout.write(`  fresh-main: ${this.status.freshMain} (${this.status.freshVersion})\n`);
    process.stdout.write(
      `  latest->main: ${this.status.upgrade} (${this.status.upgradeVersion})\n`,
    );
    process.stdout.write(`  logs: ${this.runDir}\n`);
    process.stdout.write(`  summary: ${summaryPath}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(repoRoot, { recursive: true });
  const runSmoke = () => new LinuxSmoke(options).run();
  await (options.json ? withProgressOnStderr(runSmoke) : runSmoke());
}
