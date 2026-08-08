#!/usr/bin/env -S pnpm tsx
// Native macOS CI proof for the packaged app's first-launch CLI bootstrap.
import { appendFileSync, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { sleep as delay } from "../lib/sleep.mjs";
import { run, runStreaming, say, shellQuote } from "./parallels/host-command.ts";
import { startNpmRegistryServer } from "./parallels/host-server.ts";
import { packOpenClaw, packageVersionFromTgz } from "./parallels/package-artifact.ts";
import type { NpmRegistryServer } from "./parallels/types.ts";

const gatewayLabel = "ai.openclaw.gateway";
const gatewayPort = 18789;
const installerProcessPattern = "Contents/Resources/[i]nstall-cli.sh";

type Lane = "delayed-readiness" | "matching" | "mismatch";

const laneBundleIds: Record<Lane, string> = {
  "delayed-readiness": "ai.openclaw.mac.debug.delayed",
  matching: "ai.openclaw.mac.debug",
  mismatch: "ai.openclaw.mac.debug.mismatch",
};

const oldOnboardingReadinessTimeoutMs = 12_000;
const expectedMismatchOutcome = "CLI install completed result=failed code=incompatible-version";

type StartupPreference = {
  expected: string;
  key: string;
  type: "-bool" | "-int" | "-string";
  value: string;
};

type CommandOptions = {
  check?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

type ManagedGatewayCommand = {
  entryPath: string;
  runtimePath: string;
};

function requireEphemeralCiHome(input: {
  allowReset?: string;
  ci?: string;
  home: string;
  platform: NodeJS.Platform;
}): void {
  if (input.platform !== "darwin") {
    throw new Error("macOS app bootstrap CI requires a Darwin runner");
  }
  if (input.ci !== "true" || input.allowReset !== "1") {
    throw new Error(
      "refusing to reset ~/.openclaw outside explicit CI; set CI=true and OPENCLAW_E2E_ALLOW_HOME_RESET=1",
    );
  }
  const resolvedHome = path.resolve(input.home);
  if (!resolvedHome.startsWith("/Users/") || resolvedHome.split(path.sep).length !== 3) {
    throw new Error(`refusing unsafe CI home: ${resolvedHome}`);
  }
}

async function portIsOpen(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function safeArtifactText(text: string): string {
  return redactSensitiveText(text);
}

function hasExpectedMismatchOutcome(logs: string): boolean {
  return logs.includes(expectedMismatchOutcome);
}

function appBootstrapMismatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
  if (!match) {
    throw new Error(`cannot derive app bootstrap mismatch version from ${version}`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function appBundleIdForLane(lane: Lane): string {
  return laneBundleIds[lane];
}

function pathIsWithin(root: string, candidate: string): boolean {
  const resolvedRoot = `${path.resolve(root)}${path.sep}`;
  return path.resolve(candidate).startsWith(resolvedRoot);
}

function gatewayServiceIsListening(launchAgentStatus: number, portOpen: boolean): boolean {
  return launchAgentStatus === 0 && portOpen;
}

function resolveManagedGatewayCommand(
  programArguments: unknown,
  stateDir: string,
): ManagedGatewayCommand | null {
  if (
    !Array.isArray(programArguments) ||
    !programArguments.every((value) => typeof value === "string")
  ) {
    return null;
  }

  let command = programArguments as string[];
  const serviceEnvDir = path.resolve(stateDir, "service-env");
  const isGeneratedEnvironmentPair = (wrapperPath: string, envPath: string): boolean =>
    path.dirname(path.resolve(wrapperPath)) === serviceEnvDir &&
    path.dirname(path.resolve(envPath)) === serviceEnvDir &&
    path.basename(wrapperPath) === `${gatewayLabel}-env-wrapper.sh` &&
    path.basename(envPath) === `${gatewayLabel}.env`;

  if (
    command.length >= 3 &&
    command[0] === "/bin/sh" &&
    isGeneratedEnvironmentPair(command[1]!, command[2]!)
  ) {
    command = command.slice(3);
  } else if (command.length >= 2 && isGeneratedEnvironmentPair(command[0]!, command[1]!)) {
    command = command.slice(2);
  }

  const runtimePath = command[0];
  const entryPath = command[1];
  if (
    !runtimePath ||
    !entryPath ||
    path.basename(runtimePath) !== "node" ||
    command[2] !== "gateway"
  ) {
    return null;
  }
  const portIndex = command.indexOf("--port", 3);
  if (portIndex < 0 || command[portIndex + 1] !== String(gatewayPort)) {
    return null;
  }

  const toolsRoot = path.join(stateDir, "tools");
  const managedDistMarker = ["lib", "node_modules", "openclaw", "dist"].join(path.sep);
  if (
    !pathIsWithin(toolsRoot, runtimePath) ||
    !pathIsWithin(toolsRoot, entryPath) ||
    !path.dirname(path.resolve(entryPath)).endsWith(managedDistMarker) ||
    !["entry.js", "index.js"].includes(path.basename(entryPath))
  ) {
    return null;
  }
  return { entryPath: path.resolve(entryPath), runtimePath: path.resolve(runtimePath) };
}

function delayedGatewayWrapper(
  command: ManagedGatewayCommand,
  enteredPath: string,
  releasePath: string,
): string {
  return `#!/bin/sh
set -eu
: > ${shellQuote(enteredPath)}
while [ ! -e ${shellQuote(releasePath)} ]; do
  sleep 0.1
done
exec ${shellQuote(command.runtimePath)} ${shellQuote(command.entryPath)} "$@"
`;
}

function macosLogStartTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function startupPreferencesForLane(lane: Lane): StartupPreference[] {
  const showsOnboarding = lane === "delayed-readiness";
  return [
    {
      expected: showsOnboarding ? "0" : "1",
      key: "openclaw.onboardingSeen",
      type: "-bool",
      value: showsOnboarding ? "false" : "true",
    },
    {
      expected: showsOnboarding ? "0" : "8",
      key: "openclaw.onboardingVersion",
      type: "-int",
      value: showsOnboarding ? "0" : "8",
    },
    { expected: "local", key: "openclaw.connectionMode", type: "-string", value: "local" },
    { expected: "0", key: "openclaw.pauseEnabled", type: "-bool", value: "false" },
    { expected: "1", key: "openclaw.showDockIcon", type: "-bool", value: "true" },
    { expected: "1", key: "openclaw.debug.fileLogEnabled", type: "-bool", value: "true" },
    {
      expected: "debug",
      key: "openclaw.debug.appLogLevel",
      type: "-string",
      value: "debug",
    },
  ];
}

class MacosAppBootstrapCi {
  private readonly artifactDir = path.resolve(
    process.env.OPENCLAW_MACOS_APP_BOOTSTRAP_ARTIFACT_DIR ?? ".artifacts/macos-app-bootstrap",
  );
  private readonly commandLog = path.join(this.artifactDir, "commands.log");
  private readonly home = homedir();
  private readonly stateDir = path.join(this.home, ".openclaw");
  private readonly launchAgentPath = path.join(
    this.home,
    "Library/LaunchAgents",
    `${gatewayLabel}.plist`,
  );
  private readonly uid = process.getuid?.();
  private registryServer: NpmRegistryServer | null = null;
  private tempRoot = "";
  private candidateVersion = "";
  private activeBundleId: string | null = null;
  private activeLogStart: string | null = null;

  async run(): Promise<void> {
    requireEphemeralCiHome({
      allowReset: process.env.OPENCLAW_E2E_ALLOW_HOME_RESET,
      ci: process.env.CI,
      home: this.home,
      platform: process.platform,
    });
    if (this.uid == null) {
      throw new Error("cannot resolve current macOS user id");
    }

    await mkdir(this.artifactDir, { recursive: true });
    this.tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-macos-app-bootstrap-ci."));

    try {
      await this.preflight();
      const apps = await this.prepareArtifacts();

      await this.runLane("mismatch", apps.mismatch);
      await this.runLane("matching", apps.matching);
      const delayedReadinessMs = await this.runDelayedReadinessLane(apps.delayedReadiness);

      await writeFile(
        path.join(this.artifactDir, "summary.json"),
        `${JSON.stringify(
          {
            candidateVersion: this.candidateVersion,
            delayedReadiness: {
              elapsedMs: delayedReadinessMs,
              status: "pass",
            },
            matching: "pass",
            mismatch: "pass",
          },
          null,
          2,
        )}\n`,
      );
      say(
        "Packaged macOS app bootstrap passed: mismatch rejected, matching Gateway ready, delayed onboarding recovered",
      );
    } catch (error) {
      await writeFile(
        path.join(this.artifactDir, "failure.log"),
        `${safeArtifactText(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`,
      ).catch(() => undefined);
      await this.captureDiagnostics("failure").catch(() => undefined);
      throw error;
    } finally {
      await this.resetState().catch((error: unknown) => {
        process.stderr.write(`cleanup warning: ${this.errorMessage(error)}\n`);
      });
      await this.registryServer?.stop().catch((error: unknown) => {
        process.stderr.write(`registry cleanup warning: ${this.errorMessage(error)}\n`);
      });
      if (this.tempRoot) {
        await rm(this.tempRoot, { force: true, recursive: true });
      }
    }
  }

  private async preflight(): Promise<void> {
    say("Verify logged-in macOS launchd and LaunchServices session");
    this.runStatus("/bin/launchctl", ["print", `gui/${this.uid}`], { timeoutMs: 30_000 });
    this.runLogged("/bin/test", ["-x", "/usr/bin/open"]);
    this.runLogged("/usr/bin/stat", ["-f", "console-user=%Su", "/dev/console"]);
    await this.resetState();
  }

  private async prepareArtifacts(): Promise<{
    delayedReadiness: string;
    matching: string;
    mismatch: string;
  }> {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version?: unknown };
    if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
      throw new Error("package.json does not contain a package version");
    }
    this.candidateVersion = packageJson.version.trim();

    // Pack before the .app exists under dist: Sparkle contains framework symlinks that are
    // valid in an app bundle but intentionally rejected by the npm package inventory.
    say("Pack exact-head OpenClaw npm artifact");
    const packageDir = path.join(this.tempRoot, "package");
    const artifact = await packOpenClaw({
      destination: packageDir,
      requireControlUi: true,
    });
    const packedVersion = await packageVersionFromTgz(artifact.path);
    if (packedVersion !== this.candidateVersion) {
      throw new Error(
        `packed CLI version ${packedVersion} does not match app ${this.candidateVersion}`,
      );
    }
    this.registryServer = await startNpmRegistryServer({
      hostIp: "127.0.0.1",
      packages: [
        {
          name: "openclaw",
          tarballPath: artifact.path,
          version: this.candidateVersion,
        },
      ],
    });

    const matchingApp = path.resolve("dist/macos-app-bootstrap-ci/OpenClaw.app");
    say(`Build packaged debug app ${this.candidateVersion}`);
    const packageStatus = await runStreaming("bash", ["scripts/package-mac-app.sh"], {
      env: {
        ...process.env,
        ALLOW_ADHOC_SIGNING: "1",
        APP_VERSION: this.candidateVersion,
        BUILD_CONFIG: "debug",
        OPENCLAW_PACKAGE_APP_ROOT: matchingApp,
        SIGN_IDENTITY: "-",
        SKIP_PNPM_INSTALL: "1",
        SKIP_TSC: "1",
        SKIP_UI_BUILD: "1",
      },
      logPath: path.join(this.artifactDir, "package-mac-app.log"),
      timeoutMs: 30 * 60_000,
    });
    if (packageStatus !== 0) {
      throw new Error(`package-mac-app failed with exit ${packageStatus}`);
    }

    const mismatchApp = await this.createAppVariant(matchingApp, "mismatch", {
      shortVersion: appBootstrapMismatchVersion(this.candidateVersion),
    });
    const delayedReadinessApp = await this.createAppVariant(matchingApp, "delayed-readiness");

    return {
      delayedReadiness: delayedReadinessApp,
      matching: matchingApp,
      mismatch: mismatchApp,
    };
  }

  private async createAppVariant(
    sourceApp: string,
    lane: Exclude<Lane, "matching">,
    options: { shortVersion?: string } = {},
  ): Promise<string> {
    const appPath = path.join(this.tempRoot, lane, "OpenClaw.app");
    await mkdir(path.dirname(appPath), { recursive: true });
    this.runLogged("/usr/bin/ditto", [sourceApp, appPath], { timeoutMs: 120_000 });
    const infoPlist = path.join(appPath, "Contents/Info.plist");
    this.runLogged("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :CFBundleIdentifier ${appBundleIdForLane(lane)}`,
      infoPlist,
    ]);
    if (options.shortVersion) {
      this.runLogged("/usr/libexec/PlistBuddy", [
        "-c",
        `Set :CFBundleShortVersionString ${options.shortVersion}`,
        infoPlist,
      ]);
    }
    this.runLogged("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], {
      timeoutMs: 120_000,
    });
    return appPath;
  }

  private async runLane(lane: Lane, appPath: string): Promise<void> {
    say(`Run packaged app bootstrap lane: ${lane}`);
    await this.resetState();
    await this.configureApp(appPath, lane);
    this.verifyStartupPreferences(lane);
    this.activeLogStart = macosLogStartTimestamp(new Date());
    this.runLogged("/usr/bin/open", ["-n", appPath, "--args", "--e2e-cli-channel", "stable"], {
      timeoutMs: 30_000,
    });

    if (lane === "mismatch") {
      await this.waitFor("incompatible installer rejection", 15 * 60_000, () => {
        const installerFinished =
          existsSync(path.join(this.stateDir, "tools/node/bin/node")) && !this.installerIsRunning();
        return installerFinished && hasExpectedMismatchOutcome(this.appLogs());
      });
      await this.verifyMismatch();
    } else {
      await this.waitFor("managed CLI install", 15 * 60_000, () =>
        existsSync(path.join(this.stateDir, "bin/openclaw")),
      );
      await this.verifyMatching();
    }

    await this.captureDiagnostics(lane);
  }

  private async runDelayedReadinessLane(appPath: string): Promise<number> {
    const lane: Lane = "delayed-readiness";
    say("Run packaged app bootstrap lane: delayed onboarding readiness");
    await this.stopRuntimePreservingState();
    const { gatewayEnteredPath, gatewayReleasePath, wrapperPath } =
      await this.installDelayedGatewayWrapper();
    await rm(this.launchAgentPath, { force: true });
    this.runLogged("/bin/launchctl", ["setenv", "OPENCLAW_WRAPPER", wrapperPath]);
    await this.configureApp(appPath, lane);

    this.verifyStartupPreferences(lane);
    this.activeLogStart = macosLogStartTimestamp(new Date());
    this.runLogged(
      "/usr/bin/open",
      ["-n", appPath, "--args", "--e2e-cli-channel", "stable", "--e2e-onboarding-cli"],
      { timeoutMs: 30_000 },
    );

    await this.waitFor("onboarding Gateway activation start", 60_000, () =>
      this.onboardingLogs().includes(
        "Gateway activation started executableReady=true gatewayReady=false",
      ),
    );
    await this.waitFor("delayed Gateway wrapper entry", 60_000, () =>
      existsSync(gatewayEnteredPath),
    );
    const activationStartedAt = Date.now();
    await delay(oldOnboardingReadinessTimeoutMs + 1_000);
    const preReleaseLogs = this.onboardingLogs();
    if (preReleaseLogs.includes("Gateway activation completed result=")) {
      throw new Error("onboarding completed Gateway activation before the harness released it");
    }
    if (await portIsOpen(gatewayPort)) {
      throw new Error(`Gateway port ${gatewayPort} opened before the harness released it`);
    }
    await writeFile(gatewayReleasePath, "release\n");

    await this.verifyMatching();
    await this.waitFor("onboarding readiness recovery", 60_000, () => {
      const logs = this.onboardingLogs();
      return logs.includes(
        "Gateway activation completed result=ready executableReady=true gatewayReady=true",
      );
    });
    const onboardingLogs = this.onboardingLogs();
    if (onboardingLogs.includes("Gateway activation completed result=failed")) {
      throw new Error("onboarding entered a failed terminal state before the Gateway recovered");
    }

    const elapsedMs = Date.now() - activationStartedAt;
    if (elapsedMs <= oldOnboardingReadinessTimeoutMs) {
      throw new Error(
        `delayed readiness completed ${elapsedMs}ms after onboarding activation; expected to exceed the old ${oldOnboardingReadinessTimeoutMs}ms window`,
      );
    }
    await this.captureDiagnostics(lane);
    return elapsedMs;
  }

  private async installDelayedGatewayWrapper(): Promise<{
    gatewayEnteredPath: string;
    gatewayReleasePath: string;
    wrapperPath: string;
  }> {
    const rawArguments = this.runLogged("/usr/bin/plutil", [
      "-extract",
      "ProgramArguments",
      "json",
      "-o",
      "-",
      this.launchAgentPath,
    ]).stdout;
    let programArguments: unknown;
    try {
      programArguments = JSON.parse(rawArguments);
    } catch {
      throw new Error("installed Gateway LaunchAgent has invalid ProgramArguments JSON");
    }
    const command = resolveManagedGatewayCommand(programArguments, this.stateDir);
    if (!command) {
      throw new Error(
        "installed Gateway LaunchAgent does not contain the expected managed command",
      );
    }

    const gatewayEnteredPath = path.join(this.tempRoot, "delayed-gateway.entered");
    const gatewayReleasePath = path.join(this.tempRoot, "delayed-gateway.release");
    const wrapperPath = path.join(this.tempRoot, "delayed-gateway-wrapper.sh");
    await rm(gatewayEnteredPath, { force: true });
    await rm(gatewayReleasePath, { force: true });
    await writeFile(
      wrapperPath,
      delayedGatewayWrapper(command, gatewayEnteredPath, gatewayReleasePath),
    );
    await chmod(wrapperPath, 0o700);
    return { gatewayEnteredPath, gatewayReleasePath, wrapperPath };
  }

  private async configureApp(appPath: string, lane: Lane): Promise<void> {
    const actualBundleId = this.runLogged("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIdentifier",
      path.join(appPath, "Contents/Info.plist"),
    ]).stdout.trim();
    const expectedBundleId = appBundleIdForLane(lane);
    if (actualBundleId !== expectedBundleId) {
      throw new Error(
        `unexpected ${lane} debug bundle id: ${actualBundleId}; expected ${expectedBundleId}`,
      );
    }
    this.activeBundleId = actualBundleId;

    for (const preference of startupPreferencesForLane(lane)) {
      this.runLogged("/usr/bin/defaults", [
        "write",
        actualBundleId,
        preference.key,
        preference.type,
        preference.value,
      ]);
    }

    if (!this.registryServer) {
      throw new Error("local npm registry is unavailable");
    }
    const laneLogDir = path.join(this.artifactDir, lane);
    await mkdir(laneLogDir, { recursive: true });
    for (const [key, value] of [
      ["NPM_CONFIG_REGISTRY", this.registryServer.hostUrl],
      ["npm_config_registry", this.registryServer.hostUrl],
      ["OPENCLAW_LOG_DIR", laneLogDir],
    ] as const) {
      this.runLogged("/bin/launchctl", ["setenv", key, value]);
    }
  }

  private verifyStartupPreferences(lane: Lane): void {
    const bundleId = appBundleIdForLane(lane);
    if (this.activeBundleId !== bundleId) {
      throw new Error(`cannot verify ${lane} preferences before configuring ${bundleId}`);
    }
    for (const preference of startupPreferencesForLane(lane)) {
      const actual = this.runLogged("/usr/bin/defaults", [
        "read",
        bundleId,
        preference.key,
      ]).stdout.trim();
      if (actual !== preference.expected) {
        throw new Error(
          `${lane} preference ${preference.key} read back ${JSON.stringify(actual)}; expected ${JSON.stringify(preference.expected)}`,
        );
      }
    }
  }

  private async verifyMismatch(): Promise<void> {
    const managedCli = path.join(this.stateDir, "bin/openclaw");
    if (existsSync(managedCli)) {
      throw new Error("incompatible channel replaced the managed CLI before rejection");
    }
    await delay(5_000);
    const service = this.runStatus("/bin/launchctl", ["print", `gui/${this.uid}/${gatewayLabel}`], {
      check: false,
    });
    if (service.status === 0) {
      throw new Error("incompatible CLI reached LaunchAgent installation");
    }
    if (await portIsOpen(gatewayPort)) {
      throw new Error(`incompatible CLI unexpectedly opened port ${gatewayPort}`);
    }
  }

  private async verifyMatching(): Promise<void> {
    const managedCli = path.join(this.stateDir, "bin/openclaw");
    await this.waitFor("Gateway service listener", 5 * 60_000, async () => {
      const service = this.runStatus(
        "/bin/launchctl",
        ["print", `gui/${this.uid}/${gatewayLabel}`],
        { check: false, timeoutMs: 30_000 },
      );
      return gatewayServiceIsListening(service.status, await portIsOpen(gatewayPort));
    });

    // Do not start another CLI while the app may still own startup migrations. Once launchd is
    // loaded and listening, one deep status call proves the real RPC contract without racing setup.
    this.runLogged(
      managedCli,
      ["gateway", "status", "--deep", "--require-rpc", "--timeout", "15000"],
      { timeoutMs: 30_000 },
    );
    this.runLogged(managedCli, ["config", "validate"], { timeoutMs: 60_000 });
    this.runStatus("/bin/launchctl", ["print", `gui/${this.uid}/${gatewayLabel}`], {
      timeoutMs: 30_000,
    });
    if (!(await portIsOpen(gatewayPort))) {
      throw new Error(`Gateway port ${gatewayPort} is closed`);
    }
    await this.verifyConfig(this.candidateVersion);
  }

  private async verifyConfig(expectedVersion: string): Promise<void> {
    const configPath = path.join(this.stateDir, "openclaw.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      meta?: Record<string, unknown>;
    };
    if (config.meta?.lastTouchedVersion !== expectedVersion) {
      throw new Error(`unexpected lastTouchedVersion: ${String(config.meta?.lastTouchedVersion)}`);
    }
    if (config.meta && "lastTouchedAt" in config.meta) {
      throw new Error("packaged app wrote retired meta.lastTouchedAt");
    }
  }

  private installerIsRunning(): boolean {
    return (
      this.runLogged("/usr/bin/pgrep", ["-f", installerProcessPattern], { check: false }).status ===
      0
    );
  }

  private async waitFor(
    description: string,
    timeoutMs: number,
    predicate: () => boolean | Promise<boolean>,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return;
      }
      await delay(2_000);
    }
    throw new Error(`timed out waiting for ${description}`);
  }

  private async resetState(): Promise<void> {
    if (this.uid == null) {
      return;
    }
    await this.stopRuntimePreservingState();
    for (const key of [
      "NPM_CONFIG_REGISTRY",
      "npm_config_registry",
      "OPENCLAW_LOG_DIR",
      "OPENCLAW_WRAPPER",
    ]) {
      this.runLogged("/bin/launchctl", ["unsetenv", key], { check: false });
    }
    await rm(this.launchAgentPath, { force: true });
    await rm(this.stateDir, { force: true, recursive: true });
    for (const bundleId of Object.values(laneBundleIds)) {
      this.runLogged("/usr/bin/defaults", ["delete", bundleId], { check: false });
    }
    this.activeBundleId = null;
    this.activeLogStart = null;
  }

  private async stopRuntimePreservingState(): Promise<void> {
    if (this.uid == null) {
      return;
    }
    this.runLogged("/usr/bin/pkill", ["-x", "OpenClaw"], { check: false });
    this.runLogged("/usr/bin/pkill", ["-f", installerProcessPattern], { check: false });
    try {
      await this.waitFor(
        "OpenClaw app graceful cleanup",
        5_000,
        () => run("/usr/bin/pgrep", ["-x", "OpenClaw"], { check: false, quiet: true }).status !== 0,
      );
    } catch {
      // The packaged menu-bar app can remain alive while bootstrap work unwinds. CI owns this
      // ephemeral login session, so force-stop it before resetting state for the next lane.
      this.runLogged("/usr/bin/pkill", ["-9", "-x", "OpenClaw"], { check: false });
      await this.waitFor(
        "OpenClaw app forced cleanup",
        10_000,
        () => run("/usr/bin/pgrep", ["-x", "OpenClaw"], { check: false, quiet: true }).status !== 0,
      );
    }
    this.runLogged("/bin/launchctl", ["bootout", `gui/${this.uid}/${gatewayLabel}`], {
      check: false,
    });
    await this.waitFor(
      "Gateway port cleanup",
      30_000,
      async () => !(await portIsOpen(gatewayPort)),
    );
  }

  private onboardingLogs(): string {
    return this.appLogs('category == "onboarding.cli"');
  }

  private appLogs(additionalPredicate?: string): string {
    const predicate = ['subsystem == "ai.openclaw"', additionalPredicate]
      .filter(Boolean)
      .join(" AND ");
    const timeRange = this.activeLogStart ? ["--start", this.activeLogStart] : ["--last", "10m"];
    const result = run(
      "/usr/bin/log",
      ["show", "--info", ...timeRange, "--style", "compact", "--predicate", predicate],
      { check: false, quiet: true, timeoutMs: 30_000 },
    );
    return `${result.stdout}${result.stderr}`;
  }

  private async captureDiagnostics(label: string): Promise<void> {
    const diagnostics: string[] = [];
    const capture = (title: string, command: string, args: string[]): void => {
      const result = run(command, args, { check: false, quiet: true, timeoutMs: 30_000 });
      diagnostics.push(
        `## ${title}\nexit=${result.status}\n${result.stdout}${result.stderr}`.trimEnd(),
      );
    };

    capture("console user", "/usr/bin/stat", ["-f", "%Su", "/dev/console"]);
    capture("OpenClaw processes", "/usr/bin/pgrep", ["-alf", "OpenClaw|openclaw|install-cli"]);
    const launchd = run("/bin/launchctl", ["print", `gui/${this.uid}/${gatewayLabel}`], {
      check: false,
      quiet: true,
      timeoutMs: 30_000,
    });
    const launchdSummary = `${launchd.stdout}${launchd.stderr}`
      .split("\n")
      .filter((line) => /\b(?:state|pid|last exit code)\s*=/u.test(line))
      .join("\n");
    diagnostics.push(`## Gateway LaunchAgent\nexit=${launchd.status}\n${launchdSummary}`);
    if (this.activeBundleId) {
      capture(`debug defaults (${this.activeBundleId})`, "/usr/bin/defaults", [
        "read",
        this.activeBundleId,
      ]);
    }
    capture("app unified log", "/usr/bin/log", [
      "show",
      "--info",
      "--last",
      "30m",
      "--style",
      "compact",
      "--predicate",
      'subsystem == "ai.openclaw"',
    ]);

    const configPath = path.join(this.stateDir, "openclaw.json");
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(await readFile(configPath, "utf8")) as {
          gateway?: Record<string, unknown>;
          meta?: Record<string, unknown>;
        };
        diagnostics.push(
          `## Config summary\n${JSON.stringify(
            {
              gateway: {
                bind: config.gateway?.bind,
                mode: config.gateway?.mode,
                port: config.gateway?.port,
              },
              meta: config.meta,
            },
            null,
            2,
          )}`,
        );
      } catch (error) {
        diagnostics.push(`## Config summary\n${this.errorMessage(error)}`);
      }
    }

    await writeFile(
      path.join(this.artifactDir, `diagnostics-${label}.log`),
      `${safeArtifactText(diagnostics.join("\n\n"))}\n`,
    );
  }

  private runLogged(command: string, args: string[], options: CommandOptions = {}) {
    const header = `$ ${[command, ...args].join(" ")}\n`;
    const result = run(command, args, {
      check: false,
      env: options.env,
      quiet: true,
      timeoutMs: options.timeoutMs,
    });
    const output = `${result.stdout}${result.stderr}`;
    appendFileSync(this.commandLog, safeArtifactText(`${header}${output}\n`), "utf8");
    if (result.stdout) {
      process.stdout.write(safeArtifactText(result.stdout));
    }
    if (result.stderr) {
      process.stderr.write(safeArtifactText(result.stderr));
    }
    if (options.check !== false && result.status !== 0) {
      throw new Error(`command failed (${result.status}): ${command} ${args.join(" ")}`);
    }
    return result;
  }

  private runStatus(command: string, args: string[], options: CommandOptions = {}) {
    const result = run(command, args, {
      check: false,
      env: options.env,
      quiet: true,
      timeoutMs: options.timeoutMs,
    });
    appendFileSync(
      this.commandLog,
      `$ ${[command, ...args].join(" ")}\nexit=${result.status}\n\n`,
      "utf8",
    );
    if (options.check !== false && result.status !== 0) {
      throw new Error(`command failed (${result.status}): ${command} ${args.join(" ")}`);
    }
    return result;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export const testing = {
  appBundleIdForLane,
  appBootstrapMismatchVersion,
  delayedGatewayWrapper,
  gatewayServiceIsListening,
  hasExpectedMismatchOutcome,
  macosLogStartTimestamp,
  requireEphemeralCiHome,
  resolveManagedGatewayCommand,
  startupPreferencesForLane,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await new MacosAppBootstrapCi().run().catch((error: unknown) => {
    process.stderr.write(`macOS app bootstrap CI failed: ${safeArtifactText(String(error))}\n`);
    process.stderr.write("[macos-app-bootstrap-ci] FAILED (exit 1)\n");
    process.exitCode = 1;
  });
}
