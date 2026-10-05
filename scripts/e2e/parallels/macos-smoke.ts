#!/usr/bin/env -S pnpm tsx
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { posixAgentWorkspaceScript } from "./agent-workspace.ts";
import {
  die,
  currentRunningSnapshotInfo,
  extractLastOpenClawVersionFromLog,
  makeTempDir,
  modelProviderConfigBatchJson,
  posixCodexPlatformPackageRepairFunction,
  posixProviderOnlyPluginIsolationScript,
  readGitCommitEnv,
  readPositiveIntEnv,
  resolveParallelsModelTimeoutSeconds,
  resolveHostIp,
  resolveHostPort,
  resolveLatestVersion,
  resolveProviderAuth,
  resolveSnapshot,
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
import { MacosGuest } from "./guest-transports.ts";
import { MacosDiscordSmoke } from "./macos-discord.ts";
import { runMacosHostCommand as run } from "./macos-exec.ts";
import { resolveMacosDesktopHome, resolveMacosDesktopUser } from "./macos-users.ts";
import { resolveMacosVmName, waitForVmStatus } from "./parallels-vm.ts";
import { PhaseRunner } from "./phase-runner.ts";
import {
  assertDevChannelUpdate,
  expectedPackageBuildCommit,
  expectedPackageTargetVersion,
  installSmokeRuntimeCompanions,
  npmRegistryEnv,
  packAndServeSmokeArtifact,
  parseSmokeCliArgs,
  printSmokeTargetSummary,
  posixAgentTurnScript,
  posixStopGatewayScript,
  SmokeRunController,
  type SmokeCliOptions,
} from "./smoke-common.ts";

interface MacosOptions extends SmokeCliOptions {
  vmNameExplicit: boolean;
  skipLatestRefCheck: boolean;
  discordTokenEnv?: string;
  discordGuildId?: string;
  discordChannelId?: string;
}

const guestPath =
  "/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/usr/local/bin:/usr/local/sbin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
const guestOpenClaw = "openclaw";
const guestOpenClawEntry = '"$(npm root -g)/openclaw/openclaw.mjs"';
const guestOpenClawEntryRunner = `node ${guestOpenClawEntry}`;
const guestNode = "node";
const guestNpm = "npm";

const defaultOptions = (): MacosOptions => ({
  discordChannelId: undefined,
  discordGuildId: undefined,
  discordTokenEnv: undefined,
  hostIp: undefined,
  hostPort: 18425,
  hostPortExplicit: false,
  installUrl: "https://openclaw.ai/install.sh",
  installVersion: "",
  json: false,
  keepServer: false,
  latestVersion: "",
  mode: "both",
  modelId: undefined,
  npmRegistry: undefined,
  provider: "openai",
  skipLatestRefCheck: false,
  snapshotHint: "macOS 26.5 latest",
  targetPackageSpec: "",
  vmName: "macOS Tahoe",
  vmNameExplicit: false,
});

function usage(): string {
  return `Usage: bash scripts/e2e/parallels-macos-smoke.sh [options]

Options:
  --vm <name>                Parallels VM name. Default: "macOS Tahoe"
  --snapshot-hint <name>     Snapshot name substring/fuzzy match.
                             Default: "macOS 26.5 latest"
  --mode <fresh|upgrade|both>
  --provider <openai|anthropic|minimax>
  --model <provider/model>    Override the model used for the agent-turn smoke.
  --api-key-env <var>        Host env var name for provider API key.
  --openai-api-key-env <var> Alias for --api-key-env (backward compatible)
  --install-url <url>        Installer URL for latest release. Default: https://openclaw.ai/install.sh
  --host-port <port>         Host HTTP port for current-main tgz. Default: 18425
  --host-ip <ip>             Override Parallels host IP.
  --latest-version <ver>     Override npm latest version lookup.
  --install-version <ver>    Pin site-installer version/dist-tag for the baseline lane.
  --target-package-spec <npm-spec>
                             Install this npm package tarball instead of packing current main.
  --npm-registry <url>       Registry used for target package installs.
  --skip-latest-ref-check    Skip the known latest-release ref-mode precheck in upgrade lane.
  --keep-server              Leave temp host HTTP server running.
  --discord-token-env <var>  Host env var name for Discord bot token.
  --discord-guild-id <id>    Discord guild ID for smoke roundtrip.
  --discord-channel-id <id>  Discord channel ID for smoke roundtrip.
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.

Environment:
  OPENCLAW_PARALLELS_DEV_TARGET_REF
                             Pin the guest dev update to a full commit SHA.
`;
}

export function parseArgs(argv: string[]): MacosOptions {
  const options = defaultOptions();
  return parseSmokeCliArgs(argv, options, {
    flagHandlers: {
      "--skip-latest-ref-check": (parsed) => (parsed.skipLatestRefCheck = true),
    },
    usage,
    valueHandlers: {
      "--discord-channel-id": (parsed, value) => (parsed.discordChannelId = value),
      "--discord-guild-id": (parsed, value) => (parsed.discordGuildId = value),
      "--discord-token-env": (parsed, value) => (parsed.discordTokenEnv = value),
      "--vm": (parsed, value) => {
        parsed.vmName = value;
        parsed.vmNameExplicit = true;
      },
    },
  });
}

class MacosSmoke extends SmokeRunController<MacosOptions> {
  private agentTimeoutSeconds: number;
  private auth: ProviderAuth;
  private discordToken = "";
  private artifact: PackageArtifact | null = null;
  private targetExpectVersion = "";
  private latestVersion = "";
  private installVersion = "";
  private snapshot!: SnapshotInfo;
  private phases!: PhaseRunner;
  private guest!: MacosGuest;
  private guestEnv: Record<string, string> = {};
  private discord: MacosDiscordSmoke | null = null;
  private guestUser = "";
  private guestTransport: "current-user" | "sudo" = "current-user";
  private modelTimeoutSeconds: number;
  private updateDevTimeoutSeconds: number;
  private devTargetCommit: string | undefined;
  protected status = {
    freshAgent: "skip",
    freshDashboard: "skip",
    freshDiscord: "skip",
    freshGateway: "skip",
    freshMain: "skip",
    freshVersion: "skip",
    latestInstalledVersion: "skip",
    upgrade: "skip",
    upgradeAgent: "skip",
    upgradeDashboard: "skip",
    upgradeDiscord: "skip",
    upgradeGateway: "skip",
    upgradePrecheck: "skip",
    upgradeVersion: "skip",
  };

  constructor(options: MacosOptions) {
    super(options);
    this.auth = resolveProviderAuth({
      apiKeyEnv: options.apiKeyEnv,
      modelId: options.modelId,
      provider: options.provider,
    });
    this.agentTimeoutSeconds = readPositiveIntEnv("OPENCLAW_PARALLELS_MACOS_AGENT_TIMEOUT_S", 2700);
    this.modelTimeoutSeconds = resolveParallelsModelTimeoutSeconds("macos");
    this.updateDevTimeoutSeconds = readPositiveIntEnv(
      "OPENCLAW_PARALLELS_MACOS_UPDATE_DEV_TIMEOUT_S",
      1800,
    );
    this.devTargetCommit = readGitCommitEnv("OPENCLAW_PARALLELS_DEV_TARGET_REF");
    this.validateDiscord();
  }

  async run(): Promise<void> {
    this.options.vmName = resolveMacosVmName(this.options.vmName, this.options.vmNameExplicit);
    this.runDir = await makeTempDir("openclaw-parallels-macos.");
    this.phases = new PhaseRunner(this.runDir);
    this.guest = new MacosGuest(
      {
        getTransport: () => this.guestTransport,
        getEnv: () => this.guestEnv,
        getUser: () => this.guestUser,
        path: guestPath,
        resolveDesktopHome: (user) => this.resolveDesktopHome(user),
        vmName: this.options.vmName,
      },
      this.phases,
    );
    this.discord = this.createDiscordSmoke();
    this.tgzDir = await makeTempDir("openclaw-parallels-macos-tgz.");
    try {
      validateSnapshotRestoreMode(this.options.mode, "macOS smoke");
      this.snapshot = shouldSkipSnapshotRestore()
        ? currentRunningSnapshotInfo(this.options.vmName)
        : resolveSnapshot(this.options.vmName, this.options.snapshotHint);
      this.latestVersion = resolveLatestVersion(this.options.latestVersion);
      this.installVersion = this.options.installVersion || this.latestVersion;

      say(`VM: ${this.options.vmName}`);
      say(`Snapshot hint: ${this.options.snapshotHint}`);
      say(`Resolved snapshot: ${this.snapshot.name} [${this.snapshot.state}]`);
      say(`Latest npm version: ${this.latestVersion}`);
      say(
        `Current head: ${run("git", ["rev-parse", "--short", "HEAD"], { quiet: true }).stdout.trim()}`,
      );
      say(
        `Discord smoke: ${this.discordEnabled() ? `guild=${this.options.discordGuildId} channel=${this.options.discordChannelId}` : "disabled"}`,
      );
      say(`Run logs: ${this.runDir}`);

      if (this.needsHostTgz()) {
        this.hostIp = resolveHostIp(this.options.hostIp);
        this.hostPort = await resolveHostPort(
          this.options.hostPort,
          this.options.hostPortExplicit,
          defaultOptions().hostPort,
        );
        [this.artifact, this.server, this.hostPort] = await packAndServeSmokeArtifact(
          this.tgzDir,
          this.options.targetPackageSpec,
          this.hostIp,
          this.hostPort,
          this.artifactLabel(),
          true,
          this.options.provider,
        );
        if (this.options.targetPackageSpec) {
          this.targetExpectVersion =
            this.artifact.version || (await expectedPackageTargetVersion(this.artifact));
        }
      } else if (this.targetInstallsDirectly()) {
        this.targetExpectVersion = run(
          "npm",
          [
            "view",
            this.options.targetPackageSpec || "",
            "version",
            "--userconfig",
            path.join(this.tgzDir, "npmrc"),
          ],
          { quiet: true },
        ).stdout.trim();
      }

      await this.runLanesAndFinish();
    } finally {
      await this.cleanupArtifacts();
      await this.discord?.cleanupMessages().catch(() => undefined);
      await this.stopVmAfterSuccessfulDiscordSmoke().catch(() => undefined);
    }
  }

  private validateDiscord(): void {
    if (
      !this.options.discordTokenEnv &&
      !this.options.discordGuildId &&
      !this.options.discordChannelId
    ) {
      return;
    }
    if (!this.options.discordTokenEnv) {
      die("--discord-token-env is required when Discord smoke args are set");
    }
    if (!this.options.discordGuildId) {
      die("--discord-guild-id is required when Discord smoke args are set");
    }
    if (!this.options.discordChannelId) {
      die("--discord-channel-id is required when Discord smoke args are set");
    }
    this.discordToken = process.env[this.options.discordTokenEnv] ?? "";
    if (!this.discordToken) {
      die(`${this.options.discordTokenEnv} is required for Discord smoke`);
    }
  }

  private discordEnabled(): boolean {
    return Boolean(
      this.discordToken && this.options.discordGuildId && this.options.discordChannelId,
    );
  }

  private createDiscordSmoke(): MacosDiscordSmoke | null {
    if (!this.discordEnabled()) {
      return null;
    }
    return new MacosDiscordSmoke({
      config: {
        channelId: this.options.discordChannelId || "",
        guildId: this.options.discordGuildId || "",
        token: this.discordToken,
      },
      guest: this.guest,
      guestNode,
      guestOpenClaw,
      guestOpenClawEntry,
      runDir: this.runDir,
      vmName: this.options.vmName,
    });
  }

  private targetInstallsDirectly(): boolean {
    const spec = this.options.targetPackageSpec;
    return Boolean(spec && !/^(https?:|file:|\/|\.\/|\.\.\/|.*\.tgz$)/.test(spec));
  }

  private needsHostTgz(): boolean {
    return this.options.targetPackageSpec
      ? !this.targetInstallsDirectly()
      : this.options.mode !== "upgrade";
  }

  private artifactLabel(): string {
    if (this.targetInstallsDirectly()) {
      return "target package spec";
    }
    return this.options.targetPackageSpec ? "target package tgz" : "current main tgz";
  }

  protected async runFreshLane(): Promise<void> {
    await this.phases.phase("fresh.restore-snapshot", 780, () => this.restoreSnapshot());
    await this.phases.phase("fresh.reset-state", 180, () => this.resetState());
    await this.phases.phase("fresh.install-main", 420, () =>
      this.installMain("openclaw-main-fresh.tgz"),
    );
    this.status.freshVersion = await this.extractLastVersion("fresh.install-main");
    await this.phases.phase("fresh.verify-main-version", 60, () => this.verifyTargetVersion());
    await this.phases.phase("fresh.verify-bundle-permissions", 180, () =>
      this.verifyBundlePermissions(),
    );
    await this.phases.phase("fresh.install-companions", 600, () =>
      installSmokeRuntimeCompanions({
        provider: this.options.provider,
        readCli: (args) => this.guest.exec([guestOpenClaw, ...args]),
        installCli: (args) => {
          this.guest.exec([guestOpenClaw, ...args]);
        },
      }),
    );
    await this.phases.phase("fresh.onboard-ref", 420, () => this.runRefOnboard());
    await this.runGatewaySmoke("fresh");
  }

  protected async runUpgradeLane(): Promise<void> {
    await this.phases.phase("upgrade.restore-snapshot", 780, () => this.restoreSnapshot());
    await this.phases.phase("upgrade.reset-state", 180, () => this.resetState());
    await this.phases.phase("upgrade.install-latest", 420, () => this.installLatestRelease());
    this.status.latestInstalledVersion = await this.extractLastVersion("upgrade.install-latest");
    await this.phases.phase("upgrade.verify-latest-version", 60, () =>
      this.verifyVersionContains(this.installVersion),
    );
    if (this.options.skipLatestRefCheck) {
      this.status.upgradePrecheck = "skipped";
    } else if (
      await this.phases.phaseReturns("upgrade.latest-ref-precheck", 180, () =>
        this.captureLatestRefFailure(),
      )
    ) {
      this.status.upgradePrecheck = "latest-ref-pass";
    } else {
      this.status.upgradePrecheck = "latest-ref-fail";
    }
    if (this.options.targetPackageSpec) {
      await this.phases.phase("upgrade.install-main", 420, () =>
        this.installMain("openclaw-main-upgrade.tgz"),
      );
      this.status.upgradeVersion = await this.extractLastVersion("upgrade.install-main");
      await this.phases.phase("upgrade.verify-main-version", 60, () => this.verifyTargetVersion());
      await this.phases.phase("upgrade.verify-bundle-permissions", 180, () =>
        this.verifyBundlePermissions(),
      );
    } else {
      await this.phases.phase("upgrade.update-dev", this.updateDevTimeoutSeconds, () =>
        this.runDevChannelUpdate(),
      );
      this.status.upgradeVersion = await this.extractLastVersion("upgrade.update-dev");
      await this.phases.phase("upgrade.verify-dev-channel", 60, () =>
        this.verifyDevChannelUpdate(),
      );
    }
    await this.phases.phase("upgrade.onboard-ref", 420, () => this.runRefOnboard());
    await this.runGatewaySmoke("upgrade");
  }

  private async runGatewaySmoke(lane: "fresh" | "upgrade"): Promise<void> {
    await this.phases.phase(`${lane}.gateway-start`, 180, () => this.startManualGatewayIfNeeded());
    await this.phases.phase(`${lane}.gateway-status`, 180, () => this.verifyGateway());
    this.status[`${lane}Gateway`] = "pass";
    await this.phases.phase(`${lane}.dashboard-load`, 180, () => this.verifyDashboardLoad());
    this.status[`${lane}Dashboard`] = "pass";
    await this.phases.phase(`${lane}.first-agent-turn`, this.agentTimeoutSeconds, () =>
      this.verifyTurn(),
    );
    this.status[`${lane}Agent`] = "pass";
    if (this.discordEnabled()) {
      this.status[`${lane}Discord`] = "fail";
      await this.phases.phase(`${lane}.discord-config`, 600, () => this.discord?.configure());
      await this.phases.phase(`${lane}.discord-gateway-ready`, 180, () =>
        this.ensureDiscordGatewayReady(),
      );
      await this.phases.phase(`${lane}.discord-roundtrip`, 180, () =>
        this.runDiscordRoundtrip(lane),
      );
      this.status[`${lane}Discord`] = "pass";
    }
  }

  private guestOpenClawEntryExec(
    args: string[],
    options: { check?: boolean; env?: Record<string, string> } = {},
  ): string {
    const argv = args.map((arg) => shellQuote(arg)).join(" ");
    return this.guest.sh(
      `set -e
entry="$(npm root -g)/openclaw/openclaw.mjs"
exec node "$entry" ${argv}`,
      options.env,
    );
  }

  private waitForCurrentUser(timeoutSeconds = 360): void {
    const prlctlDeadline = Date.now() + 45_000;
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < prlctlDeadline && Date.now() < deadline) {
      if (this.tryCurrentUser()) {
        return;
      }
      run("sleep", ["2"], { quiet: true });
    }
    const fallback = this.resolveDesktopUser();
    if (fallback) {
      this.guestUser = fallback;
      this.guestTransport = "sudo";
      warn(
        `desktop user unavailable via Parallels --current-user; using root sudo fallback for ${fallback}`,
      );
      return;
    }
    while (Date.now() < deadline) {
      if (this.tryCurrentUser()) {
        return;
      }
      run("sleep", ["2"], { quiet: true });
    }
    throw new Error("guest current user did not become available");
  }

  private tryCurrentUser(): boolean {
    const result = run("prlctl", ["exec", this.options.vmName, "--current-user", "whoami"], {
      check: false,
      quiet: true,
      timeoutMs: this.phases.remainingTimeoutMs(),
    });
    const user = result.stdout.trim().replaceAll("\r", "").split("\n").at(-1) ?? "";
    if (result.status !== 0 || !/^[A-Za-z0-9._-]+$/.test(user)) {
      return false;
    }
    this.guestUser = user;
    this.guestTransport = "current-user";
    return true;
  }

  private resolveDesktopUser(): string {
    return resolveMacosDesktopUser((args) => this.readDesktopUserOutput(args));
  }

  private resolveDesktopHome(user: string): string {
    return resolveMacosDesktopHome(user, (args) => this.readDesktopUserOutput(args));
  }

  private readDesktopUserOutput(args: string[]): string {
    return run("prlctl", ["exec", this.options.vmName, ...args], {
      check: false,
      quiet: true,
      timeoutMs: this.phases.remainingTimeoutMs(30_000),
    }).stdout;
  }

  private restoreSnapshot(): void {
    // A restored baseline must resolve public packages, not the previous candidate registry.
    this.guestEnv = {};
    if (shouldSkipSnapshotRestore()) {
      say(`Skip snapshot restore; using current running VM ${this.options.vmName}`);
      this.waitForCurrentUser();
      return;
    }
    say(`Restore snapshot ${this.options.snapshotHint} (${this.snapshot.id})`);
    let restored = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = run(
        "prlctl",
        ["snapshot-switch", this.options.vmName, "--id", this.snapshot.id],
        { check: false, quiet: true, timeoutMs: this.phases.remainingTimeoutMs(360_000) },
      );
      this.phases.append(result.stdout);
      this.phases.append(result.stderr);
      if (result.status === 0) {
        restored = true;
        break;
      }
      warn(`snapshot-switch attempt ${attempt} failed (rc=${result.status})`);
      const status = run("prlctl", ["status", this.options.vmName], {
        check: false,
        quiet: true,
        timeoutMs: this.phases.remainingTimeoutMs(60_000),
      }).stdout;
      if (status.includes(" running") || status.includes(" suspended")) {
        run("prlctl", ["stop", this.options.vmName, "--kill"], {
          check: false,
          quiet: true,
          timeoutMs: this.phases.remainingTimeoutMs(120_000),
        });
        waitForVmStatus(this.options.vmName, "stopped", 360, {
          probeTimeoutMs: () => this.phases.remainingTimeoutMs(30_000),
        });
      }
      run("sleep", ["3"], { quiet: true });
    }
    if (!restored) {
      throw new Error("snapshot restore failed");
    }
    const status = run("prlctl", ["status", this.options.vmName], {
      check: false,
      quiet: true,
      timeoutMs: this.phases.remainingTimeoutMs(60_000),
    }).stdout;
    if (this.snapshot.state === "poweroff" || status.includes(" stopped")) {
      waitForVmStatus(this.options.vmName, "stopped", 360, {
        probeTimeoutMs: () => this.phases.remainingTimeoutMs(30_000),
      });
      say(`Start restored poweroff snapshot ${this.snapshot.name}`);
      run("prlctl", ["start", this.options.vmName], {
        quiet: true,
        timeoutMs: this.phases.remainingTimeoutMs(120_000),
      });
    } else if (status.includes(" suspended")) {
      say(`Resume restored snapshot ${this.snapshot.name}`);
      run("prlctl", ["start", this.options.vmName], {
        quiet: true,
        timeoutMs: this.phases.remainingTimeoutMs(120_000),
      });
    }
    this.waitForCurrentUser();
  }

  private resetState(): void {
    this.guest.sh(String.raw`/usr/bin/pkill -f 'openclaw.*gateway run' >/dev/null 2>&1 || true
/usr/bin/pkill -f 'openclaw-gateway' >/dev/null 2>&1 || true
/usr/bin/pkill -f 'openclaw.mjs gateway' >/dev/null 2>&1 || true
printf 'preflight.user=%s\n' "$(whoami)"
printf 'preflight.home=%s\n' "$HOME"
printf 'preflight.path=%s\n' "$PATH"
printf 'preflight.umask=%s\n' "$(umask)"
printf 'preflight.npmRoot=%s\n' "$(${guestNpm} root -g 2>/dev/null || true)"
${guestNpm} uninstall -g openclaw >/dev/null 2>&1 || true
rm -rf "$HOME/.openclaw"
# Restored snapshots can contain corrupt optional-dependency tarballs that npm silently skips.
rm -rf "$HOME/.npm/_cacache"
rm -f /tmp/openclaw-parallels-macos-gateway.log`);
  }

  private installLatestRelease(): void {
    this.guest.sh(
      `export OPENCLAW_NO_ONBOARD=1
curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 ${shellQuote(
        this.options.installUrl,
      )} -o /tmp/openclaw-install.sh
bash /tmp/openclaw-install.sh --version ${shellQuote(this.installVersion)}
${guestOpenClaw} --version`,
    );
  }

  private installMain(tempName: string): void {
    this.guestEnv = npmRegistryEnv(this.options.npmRegistry ?? this.server?.registry?.url);
    if (this.targetInstallsDirectly()) {
      this.guest
        .sh(`printf 'install-source: registry-spec %s\\n' ${shellQuote(this.options.targetPackageSpec || "")}
for attempt in 1 2; do
  if ${guestNpm} install -g ${shellQuote(this.options.targetPackageSpec || "")}; then
    break
  fi
  if [ "$attempt" -eq 2 ]; then
    exit 1
  fi
  echo "npm install attempt $attempt failed; retrying in 5s" >&2
  sleep 5
done
${guestOpenClaw} --version`);
      return;
    }
    if (!this.artifact || !this.server) {
      die("package artifact/server missing");
    }
    const tgzUrl = this.server.urlFor(this.artifact.path);
    this.guest.sh(`printf 'install-source: host-tgz %s\\n' ${shellQuote(tgzUrl)}
curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 ${shellQuote(
      tgzUrl,
    )} -o /tmp/${tempName}
${guestNpm} install -g /tmp/${tempName}
${guestOpenClaw} --version`);
  }

  private async verifyTargetVersion(): Promise<void> {
    if (this.options.targetPackageSpec) {
      this.verifyVersionContains(this.targetExpectVersion);
      return;
    }
    if (!this.artifact) {
      die("package artifact missing");
    }
    const commit =
      this.artifact.buildCommitShort || (await expectedPackageBuildCommit(this.artifact));
    this.verifyVersionContains(commit);
  }

  private verifyVersionContains(needle: string): void {
    const version = this.guest.exec([guestOpenClaw, "--version"]);
    if (!version.includes(needle)) {
      throw new Error(`version mismatch: expected substring ${needle}`);
    }
  }

  private verifyBundlePermissions(): void {
    this.guest.sh(String.raw`set -eu
root=$(npm root -g)
check_path() {
  path="$1"
  [ -e "$path" ] || return 0
  perm=$(/usr/bin/stat -f '%OLp' "$path")
  perm_oct=$((8#$perm))
  if (( perm_oct & 0002 )); then
    echo "world-writable install artifact: $path ($perm)" >&2
    exit 1
  fi
}
check_path "$root/openclaw"
check_path "$root/openclaw/extensions"
if [ -d "$root/openclaw/extensions" ]; then
  while IFS= read -r -d '' extension_dir; do
    check_path "$extension_dir"
  done < <(/usr/bin/find "$root/openclaw/extensions" -mindepth 1 -maxdepth 1 -type d -print0)
fi`);
  }

  private runRefOnboard(): void {
    const daemonFlag = this.guestTransport === "sudo" ? "--skip-health" : "--install-daemon";
    this.guest.exec([
      "/usr/bin/env",
      `${this.auth.apiKeyEnv}=${this.auth.apiKeyValue}`,
      guestOpenClaw,
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
      daemonFlag,
      "--skip-skills",
      "--accept-risk",
      "--json",
    ]);
  }

  private captureLatestRefFailure(): void {
    this.runRefOnboard();
    this.showGatewayStatusCompat();
  }

  private ensureGuestPnpm(): void {
    const { packageManager } = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { packageManager: string };
    const spec = packageManager.replace(/\+.*$/u, "");
    const version = spec.slice("pnpm@".length);
    this.guest.sh(String.raw`set -eu
bootstrap_root=/tmp/openclaw-smoke-pnpm-bootstrap
bootstrap_bin="$bootstrap_root/node_modules/.bin"
if [ -x "$bootstrap_bin/pnpm" ] && [ "$("$bootstrap_bin/pnpm" --version)" = ${shellQuote(version)} ]; then
  echo "bootstrap-pnpm: reuse"
  "$bootstrap_bin/pnpm" --version
  exit 0
fi
echo "bootstrap-pnpm: install"
rm -rf "$bootstrap_root"
mkdir -p "$bootstrap_root"
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({private: true, allowScripts: {[process.argv[2]]: true}}))' "$bootstrap_root/package.json" ${shellQuote(spec)}
npm install --prefix "$bootstrap_root" --no-save ${shellQuote(spec)}
test "$("$bootstrap_bin/pnpm" --version)" = ${shellQuote(version)}`);
  }

  private async runDevChannelUpdate(): Promise<void> {
    this.ensureGuestPnpm();
    const home = this.guestHome();
    const devTargetEnv = this.devTargetCommit
      ? ` OPENCLAW_UPDATE_DEV_TARGET_REF=${shellQuote(this.devTargetCommit)}`
      : "";
    await this.guest.shBackground(
      "macos-update-dev",
      `set -eu
rm -rf ${shellQuote(`${home}/openclaw`)}
export PATH=${shellQuote(`/tmp/openclaw-smoke-pnpm-bootstrap/node_modules/.bin:${guestPath}`)}
${guestNode} - <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const configPath = path.join(process.env.HOME || ${JSON.stringify(home)}, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
config.update = { ...(config.update || {}), channel: "dev" };
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");
JS
/usr/bin/env NODE_OPTIONS=--max-old-space-size=8192 OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1${devTargetEnv} ${guestOpenClawEntryRunner} update --channel dev --yes --json --no-restart --timeout ${this.updateDevTimeoutSeconds}
${guestOpenClawEntryRunner} --version
${guestOpenClawEntryRunner} update status --json`,
      {},
      this.updateDevTimeoutSeconds * 1000,
    );
  }

  private verifyDevChannelUpdate(): void {
    const status = this.guestOpenClawEntryExec(["update", "status", "--json"]);
    assertDevChannelUpdate(status, this.devTargetCommit, () =>
      this.guest.sh(`git -C ${shellQuote(`${this.guestHome()}/openclaw`)} rev-parse HEAD`),
    );
  }

  private startManualGatewayIfNeeded(): void {
    if (this.guestTransport !== "sudo") {
      return;
    }
    const home = this.guestHome();
    this.guest.sh(
      `set -euo pipefail
trap '' HUP
/usr/bin/pkill -f 'openclaw.*gateway run' >/dev/null 2>&1 || true
/usr/bin/pkill -f 'openclaw-gateway' >/dev/null 2>&1 || true
/usr/bin/pkill -f 'openclaw.mjs gateway' >/dev/null 2>&1 || true
/usr/bin/env HOME=${shellQuote(home)} USER=${shellQuote(this.guestUser)} LOGNAME=${shellQuote(this.guestUser)} PATH=${shellQuote(guestPath)} ${shellQuote(
        `${this.auth.apiKeyEnv}=${this.auth.apiKeyValue}`,
      )} OPENCLAW_HOME=${shellQuote(home)} OPENCLAW_STATE_DIR=${shellQuote(`${home}/.openclaw`)} OPENCLAW_CONFIG_PATH=${shellQuote(
        `${home}/.openclaw/openclaw.json`,
      )} ${guestOpenClawEntryRunner} gateway run --bind loopback --port 18789 --force </dev/null >/tmp/openclaw-parallels-macos-gateway.log 2>&1 &
sleep 1`,
    );
  }

  private verifyGateway(): void {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const result = this.guestOpenClaw([
        "gateway",
        "status",
        "--deep",
        "--require-rpc",
        "--timeout",
        "15000",
      ]);
      if (result) {
        return;
      }
      if (attempt < 8) {
        warn(`gateway-status retry ${attempt}`);
        run("sleep", ["5"], { quiet: true });
      }
    }
    throw new Error("gateway status did not become RPC-ready");
  }

  private showGatewayStatusCompat(): void {
    const help = this.guest.exec([guestOpenClaw, "gateway", "status", "--help"], { check: false });
    const args = help.includes("--require-rpc")
      ? ["gateway", "status", "--deep", "--require-rpc"]
      : ["gateway", "status", "--deep"];
    if (!this.guestOpenClaw(args)) {
      throw new Error("gateway status failed");
    }
  }

  private guestOpenClaw(args: string[]): boolean {
    const result = this.guest.run([guestOpenClaw, ...args], { check: false });
    return result.status === 0;
  }

  private verifyDashboardLoad(): void {
    this.guest.sh(String.raw`set -eu
deadline=$((SECONDS + 120))
while [ $SECONDS -lt $deadline ]; do
  if curl -fsSL --connect-timeout 2 --max-time 5 http://127.0.0.1:18789/ >/tmp/openclaw-dashboard-smoke.html 2>/dev/null; then
    if grep -F '<title>OpenClaw Control</title>' /tmp/openclaw-dashboard-smoke.html >/dev/null &&
      grep -F '<openclaw-app></openclaw-app>' /tmp/openclaw-dashboard-smoke.html >/dev/null; then
      asset_paths="$(
        sed -nE 's/.*<(script|link)[^>]*(src|href)=["'"'"']([^"'"'"']+)["'"'"'].*/\3/p' /tmp/openclaw-dashboard-smoke.html |
          grep -E '(^|/)assets/' |
          grep -Ev '^(https?:)?//' |
          sort -u
      )"
      if [ -n "$asset_paths" ]; then
        assets_ok=1
        while IFS= read -r asset_path; do
          [ -n "$asset_path" ] || continue
          case "$asset_path" in
            http://127.0.0.1:18789/*) asset_url="$asset_path" ;;
            /*) asset_url="http://127.0.0.1:18789$asset_path" ;;
            *) asset_url="http://127.0.0.1:18789/$asset_path" ;;
          esac
          curl -fsSL --connect-timeout 2 --max-time 5 "$asset_url" >/dev/null 2>/dev/null ||
            assets_ok=0
        done <<EOF
$asset_paths
EOF
        [ "$assets_ok" -eq 1 ] && exit 0
      fi
    fi
  fi
  sleep 1
done
echo "dashboard HTML did not become ready" >&2
exit 1`);
  }

  private restrictAgentTurnPlugins(): void {
    this.guest.sh(
      posixProviderOnlyPluginIsolationScript({
        fallbackPluginId: this.options.provider,
        homeFallback: this.guestHome(),
        modelId: this.auth.modelId,
        nodeCommand: guestNode,
      }),
    );
  }

  private verifyTurn(): void {
    this.guest.sh(
      `set -euo pipefail\n${posixStopGatewayScript(this.guestTransport === "sudo" ? undefined : guestOpenClawEntryRunner)}`,
    );
    this.guestOpenClawEntryExec(["models", "set", this.auth.modelId]);
    const modelProviderConfigBatch = modelProviderConfigBatchJson(
      this.auth.modelId,
      "macos",
      this.modelTimeoutSeconds,
    );
    if (modelProviderConfigBatch) {
      this.guest.sh(`provider_config_batch="$(mktemp)"
cat >"$provider_config_batch" <<'JSON'
${modelProviderConfigBatch}
JSON
${guestOpenClawEntryRunner} config set --batch-file "$provider_config_batch" --strict-json
rm -f "$provider_config_batch"`);
    }
    this.guestOpenClawEntryExec([
      "config",
      "set",
      "agents.defaults.skipBootstrap",
      "true",
      "--strict-json",
    ]);
    this.guestOpenClawEntryExec(["config", "set", "tools.profile", "minimal"]);
    this.restrictAgentTurnPlugins();
    this.guest.sh(
      `${posixAgentWorkspaceScript("Parallels macOS smoke test assistant.")}
${posixCodexPlatformPackageRepairFunction()}
${posixAgentTurnScript({
  command: `/usr/bin/env ${shellQuote(`${this.auth.apiKeyEnv}=${this.auth.apiKeyValue}`)} ${guestOpenClawEntryRunner} agent --local --agent main --session-id "$session_id" --message ${shellQuote(
    "Reply with exact ASCII text OK only.",
  )} --thinking off --timeout ${this.modelTimeoutSeconds} --json`,
  sessionIdExpression: '"parallels-macos-smoke"',
  retrySessionIdExpression: '"parallels-macos-smoke-retry-$attempt"',
  printOutput: "cat",
})}`,
    );
  }

  private ensureDiscordGatewayReady(): void {
    this.startManualGatewayIfNeeded();
    this.verifyGateway();
    const status = this.guestOpenClawEntryExec(["channels", "status", "--probe", "--json"]);
    if (!status.includes('"discord"')) {
      throw new Error("Discord channel unavailable after gateway restart");
    }
  }

  private async runDiscordRoundtrip(phase: "fresh" | "upgrade"): Promise<void> {
    if (!this.discord) {
      throw new Error("Discord smoke is not configured");
    }
    await this.discord.runRoundtrip(phase);
  }

  private async stopVmAfterSuccessfulDiscordSmoke(): Promise<void> {
    this.discord?.stopVmAfterSuccessfulSmoke(this.status.freshDiscord, this.status.upgradeDiscord);
  }

  private guestHome(): string {
    if (!this.guestUser) {
      this.waitForCurrentUser();
    }
    return this.guestTransport === "sudo"
      ? this.resolveDesktopHome(this.guestUser)
      : this.guest.exec(["/usr/bin/id", "-P"]).split(":")[8] || `/Users/${this.guestUser}`;
  }

  private async extractLastVersion(phaseName: string): Promise<string> {
    return await extractLastOpenClawVersionFromLog(path.join(this.runDir, `${phaseName}.log`));
  }

  private upgradeSummaryLabel(): string {
    return this.options.targetPackageSpec ? "latest->target-package" : "latest->dev";
  }

  protected async writeSummary(): Promise<string> {
    const summary = {
      currentHead:
        this.artifact?.buildCommitShort ||
        run("git", ["rev-parse", "--short", "HEAD"], { quiet: true }).stdout.trim(),
      freshMain: {
        agent: this.status.freshAgent,
        dashboard: this.status.freshDashboard,
        discord: this.status.freshDiscord,
        gateway: this.status.freshGateway,
        status: this.status.freshMain,
        version: this.status.freshVersion,
      },
      installVersion: this.installVersion,
      latestVersion: this.latestVersion,
      mode: this.options.mode,
      provider: this.options.provider,
      runDir: this.runDir,
      snapshotHint: this.options.snapshotHint,
      snapshotId: this.snapshot.id,
      targetPackageSpec: this.options.targetPackageSpec || "",
      upgrade: {
        agent: this.status.upgradeAgent,
        dashboard: this.status.upgradeDashboard,
        discord: this.status.upgradeDiscord,
        gateway: this.status.upgradeGateway,
        latestVersionInstalled: this.status.latestInstalledVersion,
        mainVersion: this.status.upgradeVersion,
        path: this.upgradeSummaryLabel(),
        precheck: this.status.upgradePrecheck,
        status: this.status.upgrade,
      },
      vm: this.options.vmName,
    };
    const summaryPath = path.join(this.runDir, "summary.json");
    await writeJson(summaryPath, summary);
    await writeSummaryMarkdown({
      lines: [
        `- vm: ${summary.vm}`,
        `- target: ${summary.targetPackageSpec || "current main"}`,
        `- fresh: ${summary.freshMain.status} ${summary.freshMain.version}`,
        `- fresh gateway/dashboard/agent: ${summary.freshMain.gateway}/${summary.freshMain.dashboard}/${summary.freshMain.agent}`,
        `- upgrade: ${summary.upgrade.status} ${summary.upgrade.mainVersion}`,
        `- logs: ${summary.runDir}`,
      ],
      summaryPath,
      title: "macOS Parallels Smoke",
    });
    return summaryPath;
  }

  protected printSummary(summaryPath: string): void {
    process.stdout.write("\nSummary:\n");
    printSmokeTargetSummary({
      targetPackageSpec: this.options.targetPackageSpec,
      installVersion: this.installVersion,
    });
    process.stdout.write(
      `  fresh-main: ${this.status.freshMain} (${this.status.freshVersion}) discord=${this.status.freshDiscord}\n`,
    );
    process.stdout.write(
      `  latest precheck: ${this.status.upgradePrecheck} (${this.status.latestInstalledVersion})\n`,
    );
    process.stdout.write(
      `  ${this.upgradeSummaryLabel()}: ${this.status.upgrade} (${this.status.upgradeVersion}) discord=${this.status.upgradeDiscord}\n`,
    );
    process.stdout.write(`  logs: ${this.runDir}\n`);
    process.stdout.write(`  summary: ${summaryPath}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const runSmoke = () => new MacosSmoke(options).run();
  const runPromise = options.json ? withProgressOnStderr(runSmoke) : runSmoke();
  await runPromise.catch((error: unknown) => {
    die(error instanceof Error ? error.message : String(error));
  });
}
