#!/usr/bin/env -S pnpm tsx
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { posixAgentWorkspaceScript, windowsAgentWorkspaceScript } from "./agent-workspace.ts";
import {
  die,
  ensureValue,
  makeTempDir,
  packOpenClaw,
  parsePlatformList,
  parseProvider,
  repoRoot,
  resolveHostIp,
  resolveLatestVersion,
  resolveProviderAuth,
  run,
  say,
  shellQuote,
  startHostServer,
  warn,
  writeJson,
  type HostServer,
  type PackageArtifact,
  type Platform,
  type Provider,
  type ProviderAuth,
} from "./common.ts";
import { encodePowerShell, psSingleQuote } from "./powershell.ts";

interface NpmUpdateOptions {
  packageSpec: string;
  updateTarget: string;
  platforms: Set<Platform>;
  provider: Provider;
  apiKeyEnv?: string;
  modelId?: string;
  json: boolean;
}

interface Job {
  done: boolean;
  label: string;
  logPath: string;
  promise: Promise<number>;
}

interface NpmUpdateSummary {
  packageSpec: string;
  updateTarget: string;
  updateExpected: string;
  provider: Provider;
  latestVersion: string;
  currentHead: string;
  runDir: string;
  fresh: Record<Platform, string>;
  update: Record<Platform, { status: string; version: string }>;
}

const macosVm = "macOS Tahoe";
const windowsVm = "Windows 11";
const linuxVmDefault = "Ubuntu 24.04.3 ARM64";
const updateTimeoutSeconds = Number(process.env.OPENCLAW_PARALLELS_NPM_UPDATE_TIMEOUT_S || 1200);

function usage(): string {
  return `Usage: bash scripts/e2e/parallels-npm-update-smoke.sh [options]

Options:
  --package-spec <npm-spec>  Baseline npm package spec. Default: openclaw@latest
  --update-target <target>    Target passed to guest 'openclaw update --tag'.
                             Default: host-served tgz packed from current checkout.
  --platform <list>           Comma-separated platforms to run: all, macos, windows, linux.
                             Default: all
  --provider <openai|anthropic|minimax>
  --model <provider/model>    Override the model used for agent-turn smoke checks.
  --api-key-env <var>        Host env var name for provider API key.
  --openai-api-key-env <var> Alias for --api-key-env (backward compatible)
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.
`;
}

function parseArgs(argv: string[]): NpmUpdateOptions {
  const options: NpmUpdateOptions = {
    apiKeyEnv: undefined,
    json: false,
    modelId: undefined,
    packageSpec: "",
    platforms: parsePlatformList("all"),
    provider: "openai",
    updateTarget: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--":
        break;
      case "--package-spec":
        options.packageSpec = ensureValue(argv, i, arg);
        i++;
        break;
      case "--update-target":
        options.updateTarget = ensureValue(argv, i, arg);
        i++;
        break;
      case "--platform":
      case "--only":
        options.platforms = parsePlatformList(ensureValue(argv, i, arg));
        i++;
        break;
      case "--provider":
        options.provider = parseProvider(ensureValue(argv, i, arg));
        i++;
        break;
      case "--model":
        options.modelId = ensureValue(argv, i, arg);
        i++;
        break;
      case "--api-key-env":
      case "--openai-api-key-env":
        options.apiKeyEnv = ensureValue(argv, i, arg);
        i++;
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(usage());
        process.exit(0);
      default:
        die(`unknown arg: ${arg}`);
    }
  }
  return options;
}

function platformRecord<T>(value: T): Record<Platform, T> {
  return { linux: value, macos: value, windows: value };
}

class NpmUpdateSmoke {
  private auth: ProviderAuth;
  private runDir = "";
  private tgzDir = "";
  private latestVersion = "";
  private packageSpec = "";
  private currentHead = "";
  private currentHeadShort = "";
  private hostIp = "";
  private server: HostServer | null = null;
  private artifact: PackageArtifact | null = null;
  private updateTargetEffective = "";
  private updateExpectedNeedle = "";
  private linuxVm = linuxVmDefault;

  private freshStatus = platformRecord("skip");
  private updateStatus = platformRecord("skip");
  private updateVersion = platformRecord("skip");

  constructor(private options: NpmUpdateOptions) {
    this.auth = resolveProviderAuth({
      apiKeyEnv: options.apiKeyEnv,
      modelId: options.modelId,
      provider: options.provider,
    });
  }

  async run(): Promise<void> {
    this.runDir = await makeTempDir("openclaw-parallels-npm-update.");
    this.tgzDir = await makeTempDir("openclaw-parallels-npm-update-tgz.");
    try {
      this.latestVersion = resolveLatestVersion();
      this.packageSpec = this.options.packageSpec || `openclaw@${this.latestVersion}`;
      this.currentHead = run("git", ["rev-parse", "HEAD"], { quiet: true }).stdout.trim();
      this.currentHeadShort = run("git", ["rev-parse", "--short=7", "HEAD"], {
        quiet: true,
      }).stdout.trim();
      this.hostIp = resolveHostIp("");

      if (this.options.platforms.has("linux")) {
        this.linuxVm = this.resolveLinuxVmName();
      }
      this.preflightRegistryUpdateTarget();

      say(`Run fresh npm baseline: ${this.packageSpec}`);
      say(`Platforms: ${[...this.options.platforms].join(",")}`);
      say(`Run dir: ${this.runDir}`);
      await this.runFreshBaselines();

      await this.prepareUpdateTarget();
      say(`Run same-guest openclaw update to ${this.updateTargetEffective}`);
      await this.runSameGuestUpdates();

      const summaryPath = await this.writeSummary();
      if (this.options.json) {
        process.stdout.write(await readFile(summaryPath, "utf8"));
      } else {
        say(`Run dir: ${this.runDir}`);
        process.stdout.write(await readFile(summaryPath, "utf8"));
      }
    } finally {
      await this.server?.stop().catch(() => undefined);
      await rm(this.tgzDir, { force: true, recursive: true }).catch(() => undefined);
    }
  }

  private async runFreshBaselines(): Promise<void> {
    const jobs: Job[] = [];
    if (this.options.platforms.has("macos")) {
      jobs.push(this.spawnFresh("macOS", "macos", []));
    }
    if (this.options.platforms.has("windows")) {
      jobs.push(this.spawnFresh("Windows", "windows", []));
    }
    if (this.options.platforms.has("linux")) {
      jobs.push(
        this.spawnFresh("Linux", "linux", ["--vm", this.linuxVm], {
          OPENCLAW_PARALLELS_LINUX_DISABLE_BONJOUR: "1",
        }),
      );
    }
    await this.monitorJobs("fresh", jobs);
    for (const job of jobs) {
      const status = (await job.promise) === 0 ? "pass" : "fail";
      const platform = this.platformFromLabel(job.label);
      this.freshStatus[platform] = status;
      if (status !== "pass") {
        this.dumpLogTail(job.logPath);
        die(`${job.label} fresh baseline failed`);
      }
    }
  }

  private spawnFresh(
    label: string,
    platform: Platform,
    extraArgs: string[],
    env: NodeJS.ProcessEnv = {},
  ): Job {
    const logPath = path.join(this.runDir, `${platform}-fresh.log`);
    const args = [
      "exec",
      "tsx",
      `scripts/e2e/parallels/${platform}-smoke.ts`,
      "--mode",
      "fresh",
      "--provider",
      this.options.provider,
      "--model",
      this.auth.modelId,
      "--api-key-env",
      this.auth.apiKeyEnv,
      "--target-package-spec",
      this.packageSpec,
      "--json",
      ...extraArgs,
    ];
    const job: Job = {
      done: false,
      label,
      logPath,
      promise: Promise.resolve(1),
    };
    job.promise = this.spawnLogged("pnpm", args, logPath, env).finally(() => {
      job.done = true;
    });
    return job;
  }

  private async prepareUpdateTarget(): Promise<void> {
    if (!this.options.updateTarget || this.options.updateTarget === "local-main") {
      this.artifact = await packOpenClaw({
        destination: this.tgzDir,
        requireControlUi: true,
        stageRuntimeDeps: true,
      });
      this.server = await startHostServer({
        artifactPath: this.artifact.path,
        dir: this.tgzDir,
        hostIp: this.hostIp,
        label: "current main tgz",
        port: 0,
      });
      this.updateTargetEffective = this.server.urlFor(this.artifact.path);
      this.updateExpectedNeedle = this.currentHeadShort;
      return;
    }
    this.updateTargetEffective = this.options.updateTarget;
    this.updateExpectedNeedle = this.isExplicitPackageTarget(this.updateTargetEffective)
      ? ""
      : this.resolveRegistryTargetVersion(this.updateTargetEffective) || this.updateTargetEffective;
  }

  private async runSameGuestUpdates(): Promise<void> {
    const jobs: Job[] = [];
    if (this.options.platforms.has("macos")) {
      this.ensureVmRunning(macosVm);
      jobs.push(this.spawnUpdate("macOS", "macos", () => this.runMacosUpdate()));
    }
    if (this.options.platforms.has("windows")) {
      this.ensureVmRunning(windowsVm);
      jobs.push(this.spawnUpdate("Windows", "windows", () => this.runWindowsUpdate()));
    }
    if (this.options.platforms.has("linux")) {
      this.ensureVmRunning(this.linuxVm);
      jobs.push(this.spawnUpdate("Linux", "linux", () => this.runLinuxUpdate()));
    }
    await this.monitorJobs("update", jobs);
    for (const job of jobs) {
      const platform = this.platformFromLabel(job.label);
      const status = (await job.promise) === 0 ? "pass" : "fail";
      this.updateStatus[platform] = status;
      this.updateVersion[platform] = await this.extractLastVersion(job.logPath);
      if (status !== "pass") {
        this.dumpLogTail(job.logPath);
        die(`${job.label} update failed`);
      }
    }
  }

  private spawnUpdate(label: string, platform: Platform, fn: () => void): Job {
    const logPath = path.join(this.runDir, `${platform}-update.log`);
    const job: Job = {
      done: false,
      label,
      logPath,
      promise: Promise.resolve(1),
    };
    job.promise = (async () => {
      const originalStdout = process.stdout.write.bind(process.stdout);
      const originalStderr = process.stderr.write.bind(process.stderr);
      let log = "";
      const append = (chunk: string | Uint8Array): boolean => {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        log += text;
        return true;
      };
      const timeout = setTimeout(() => {
        append(`${label} update timed out after ${updateTimeoutSeconds}s\n`);
      }, updateTimeoutSeconds * 1000);
      try {
        process.stdout.write = ((chunk: string | Uint8Array) =>
          append(chunk)) as typeof process.stdout.write;
        process.stderr.write = ((chunk: string | Uint8Array) =>
          append(chunk)) as typeof process.stderr.write;
        fn();
        await writeFile(logPath, log, "utf8");
        return 0;
      } catch (error) {
        append(`${error instanceof Error ? error.message : String(error)}\n`);
        await writeFile(logPath, log, "utf8");
        return 1;
      } finally {
        clearTimeout(timeout);
        process.stdout.write = originalStdout;
        process.stderr.write = originalStderr;
      }
    })().finally(() => {
      job.done = true;
    });
    return job;
  }

  private runMacosUpdate(): void {
    const expectedCheck = this.updateExpectedNeedle
      ? `version="$(/opt/homebrew/bin/openclaw --version)"; printf '%s\\n' "$version"; case "$version" in *${shellQuote(
          this.updateExpectedNeedle,
        )}*) ;; *) echo "version mismatch: expected ${this.updateExpectedNeedle}" >&2; exit 1 ;; esac`
      : "/opt/homebrew/bin/openclaw --version";
    const script = String.raw`set -euo pipefail
scrub_future_plugin_entries() {
  python3 - <<'PY'
import json
from pathlib import Path
path = Path.home() / ".openclaw" / "openclaw.json"
if not path.exists():
    raise SystemExit(0)
try:
    config = json.loads(path.read_text())
except Exception:
    raise SystemExit(0)
plugins = config.get("plugins")
if not isinstance(plugins, dict):
    raise SystemExit(0)
entries = plugins.get("entries")
if isinstance(entries, dict):
    entries.pop("feishu", None)
    entries.pop("whatsapp", None)
allow = plugins.get("allow")
if isinstance(allow, list):
    plugins["allow"] = [item for item in allow if item not in {"feishu", "whatsapp"}]
path.write_text(json.dumps(config, indent=2) + "\n")
PY
}
stop_openclaw_gateway_processes() {
  OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 /opt/homebrew/bin/openclaw gateway stop || true
  pkill -f 'openclaw.*gateway' >/dev/null 2>&1 || true
}
scrub_future_plugin_entries
stop_openclaw_gateway_processes
OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 /opt/homebrew/bin/openclaw update --tag ${shellQuote(this.updateTargetEffective)} --yes --json
${expectedCheck}
/opt/homebrew/bin/openclaw gateway restart
/opt/homebrew/bin/openclaw gateway status --deep --require-rpc
/opt/homebrew/bin/openclaw models set ${shellQuote(this.auth.modelId)}
/opt/homebrew/bin/openclaw config set agents.defaults.skipBootstrap true --strict-json
${posixAgentWorkspaceScript("Parallels npm update smoke test assistant.")}
${this.auth.apiKeyEnv}=${shellQuote(this.auth.apiKeyValue)} /opt/homebrew/bin/openclaw agent --local --agent main --session-id parallels-npm-update-macos --message 'Reply with exact ASCII text OK only.' --json`;
    this.guestMacos(script, updateTimeoutSeconds * 1000);
  }

  private runWindowsUpdate(): void {
    const expected = this.updateExpectedNeedle;
    this.guestWindows(
      `$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
function Remove-FuturePluginEntries {
  $configPath = Join-Path $env:USERPROFILE '.openclaw\\openclaw.json'
  if (-not (Test-Path $configPath)) { return }
  try { $config = Get-Content $configPath -Raw | ConvertFrom-Json -AsHashtable } catch { return }
  $plugins = $config['plugins']
  if (-not ($plugins -is [hashtable])) { return }
  $entries = $plugins['entries']
  if ($entries -is [hashtable]) {
    foreach ($pluginId in @('feishu', 'whatsapp')) {
      if ($entries.ContainsKey($pluginId)) { $entries.Remove($pluginId) }
    }
  }
  $allow = $plugins['allow']
  if ($allow -is [array]) {
    $plugins['allow'] = @($allow | Where-Object { $_ -notin @('feishu', 'whatsapp') })
  }
  $config | ConvertTo-Json -Depth 100 | Set-Content -Path $configPath -Encoding UTF8
}
function Stop-OpenClawGatewayProcesses {
  $openclaw = Join-Path $env:APPDATA 'npm\\openclaw.cmd'
  & $openclaw gateway stop *>&1 | Out-Host
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'openclaw.*gateway' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
Remove-FuturePluginEntries
Stop-OpenClawGatewayProcesses
$env:OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1'
$openclaw = Join-Path $env:APPDATA 'npm\\openclaw.cmd'
& $openclaw update --tag ${psSingleQuote(this.updateTargetEffective)} --yes --json
if ($LASTEXITCODE -ne 0) { throw "openclaw update failed with exit code $LASTEXITCODE" }
$version = & $openclaw --version
$version
${expected ? `if (($version | Out-String) -notlike ${psSingleQuote(`*${expected}*`)}) { throw ${psSingleQuote(`version mismatch: expected ${expected}`)} }` : ""}
& $openclaw gateway restart
& $openclaw gateway status --deep --require-rpc
& $openclaw models set ${psSingleQuote(this.auth.modelId)}
& $openclaw config set agents.defaults.skipBootstrap true --strict-json
${windowsAgentWorkspaceScript("Parallels npm update smoke test assistant.")}
Set-Item -Path ('Env:' + ${psSingleQuote(this.auth.apiKeyEnv)}) -Value ${psSingleQuote(this.auth.apiKeyValue)}
& $openclaw agent --local --agent main --session-id parallels-npm-update-windows --message 'Reply with exact ASCII text OK only.' --json`,
      updateTimeoutSeconds * 1000,
    );
  }

  private runLinuxUpdate(): void {
    const expectedCheck = this.updateExpectedNeedle
      ? `version="$(openclaw --version)"; printf '%s\\n' "$version"; case "$version" in *${shellQuote(this.updateExpectedNeedle)}*) ;; *) echo "version mismatch: expected ${this.updateExpectedNeedle}" >&2; exit 1 ;; esac`
      : "openclaw --version";
    const script = String.raw`set -euo pipefail
scrub_future_plugin_entries() {
  node - <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const configPath = path.join(process.env.HOME || "/root", ".openclaw", "openclaw.json");
if (!fs.existsSync(configPath)) process.exit(0);
let config;
try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { process.exit(0); }
const plugins = config.plugins;
if (!plugins || typeof plugins !== "object") process.exit(0);
if (plugins.entries && typeof plugins.entries === "object") {
  delete plugins.entries.feishu;
  delete plugins.entries.whatsapp;
}
if (Array.isArray(plugins.allow)) {
  plugins.allow = plugins.allow.filter((id) => id !== "feishu" && id !== "whatsapp");
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
JS
}
stop_openclaw_gateway_processes() {
  OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 openclaw gateway stop || true
  pkill -f 'openclaw.*gateway' >/dev/null 2>&1 || true
}
scrub_future_plugin_entries
stop_openclaw_gateway_processes
OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 openclaw update --tag ${shellQuote(this.updateTargetEffective)} --yes --json
${expectedCheck}
openclaw gateway restart
openclaw gateway status --deep --require-rpc
openclaw models set ${shellQuote(this.auth.modelId)}
openclaw config set agents.defaults.skipBootstrap true --strict-json
${posixAgentWorkspaceScript("Parallels npm update smoke test assistant.")}
${this.auth.apiKeyEnv}=${shellQuote(this.auth.apiKeyValue)} openclaw agent --local --agent main --session-id parallels-npm-update-linux --message 'Reply with exact ASCII text OK only.' --json`;
    this.guestLinux(script, updateTimeoutSeconds * 1000);
  }

  private spawnLogged(
    command: string,
    args: string[],
    logPath: string,
    env: NodeJS.ProcessEnv = {},
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let log = "";
      child.stdout.on("data", (chunk: Buffer) => {
        log += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        log += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", async (code) => {
        await writeFile(logPath, log, "utf8");
        resolve(code ?? 1);
      });
    });
  }

  private async monitorJobs(label: string, jobs: Job[]): Promise<void> {
    const pending = new Set(jobs.map((job) => job.label));
    while (pending.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      for (const job of jobs) {
        if (!pending.has(job.label)) {
          continue;
        }
        if (job.done) {
          pending.delete(job.label);
        }
      }
      if (pending.size > 0) {
        say(`${label} still running: ${[...pending].join(", ")}`);
      }
    }
  }

  private guestMacos(script: string, timeoutMs: number): void {
    run(
      "prlctl",
      [
        "exec",
        macosVm,
        "--current-user",
        "/usr/bin/env",
        "PATH=/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin",
        "/bin/bash",
        "-lc",
        script,
      ],
      { timeoutMs },
    );
  }

  private guestWindows(script: string, timeoutMs: number): void {
    run(
      "prlctl",
      [
        "exec",
        windowsVm,
        "--current-user",
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShell(script),
      ],
      { timeoutMs },
    );
  }

  private guestLinux(script: string, timeoutMs: number): void {
    run("prlctl", ["exec", this.linuxVm, "/usr/bin/env", "HOME=/root", "bash", "-lc", script], {
      timeoutMs,
    });
  }

  private ensureVmRunning(vmName: string): void {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const status = this.vmStatus(vmName);
      if (status === "running") {
        return;
      }
      if (status === "stopped") {
        say(`Start ${vmName} before update phase`);
        run("prlctl", ["start", vmName], { quiet: true });
      } else if (status === "suspended" || status === "paused") {
        say(`Resume ${vmName} before update phase`);
        run("prlctl", ["resume", vmName], { quiet: true });
      } else if (status === "missing") {
        die(`VM not found before update phase: ${vmName}`);
      }
      run("sleep", ["5"], { quiet: true });
    }
    die(`VM did not become running before update phase: ${vmName}`);
  }

  private vmStatus(vmName: string): string {
    const payload = JSON.parse(
      run("prlctl", ["list", "--all", "--json"], { quiet: true }).stdout,
    ) as Array<{
      name?: string;
      status?: string;
    }>;
    return payload.find((vm) => vm.name === vmName)?.status || "missing";
  }

  private resolveLinuxVmName(): string {
    const payload = JSON.parse(
      run("prlctl", ["list", "--all", "--json"], { quiet: true }).stdout,
    ) as Array<{
      name?: string;
    }>;
    const names = payload.map((item) => (item.name ?? "").trim()).filter(Boolean);
    if (names.includes(linuxVmDefault)) {
      return linuxVmDefault;
    }
    const fallback = names.find((name) => /ubuntu/i.test(name));
    if (!fallback) {
      die(`VM not found: ${linuxVmDefault}`);
    }
    warn(`requested VM ${linuxVmDefault} not found; using ${fallback}`);
    return fallback;
  }

  private resolveRegistryTargetVersion(target: string): string {
    const spec = target.startsWith("openclaw@") ? target : `openclaw@${target}`;
    return (
      run("npm", ["view", spec, "version"], { check: false, quiet: true })
        .stdout.trim()
        .split("\n")
        .at(-1) ?? ""
    );
  }

  private isExplicitPackageTarget(target: string): boolean {
    return (
      target.includes("://") ||
      target.includes("#") ||
      /^(file|github|git\+ssh|git\+https|git\+http|git\+file|npm):/.test(target)
    );
  }

  private preflightRegistryUpdateTarget(): void {
    if (
      !this.options.updateTarget ||
      this.options.updateTarget === "local-main" ||
      this.isExplicitPackageTarget(this.options.updateTarget)
    ) {
      return;
    }
    const baseline = this.resolveRegistryTargetVersion(this.packageSpec);
    const target = this.resolveRegistryTargetVersion(this.options.updateTarget);
    if (baseline && target && baseline === target) {
      die(
        `--update-target ${this.options.updateTarget} resolves to openclaw@${target}, same as baseline ${this.packageSpec}; publish or choose a newer --update-target before running VM update coverage`,
      );
    }
  }

  private platformFromLabel(label: string): Platform {
    if (label === "macOS") {
      return "macos";
    }
    return label.toLowerCase() as Platform;
  }

  private async extractLastVersion(logPath: string): Promise<string> {
    const log = await readFile(logPath, "utf8").catch(() => "");
    const matches = [...log.matchAll(/openclaw\s+([0-9][^\s]*)/g)];
    return matches.at(-1)?.[1] ?? "";
  }

  private dumpLogTail(logPath: string): void {
    const log = run("tail", ["-n", "80", logPath], { check: false, quiet: true }).stdout;
    if (log) {
      process.stderr.write(log);
    }
  }

  private async writeSummary(): Promise<string> {
    const summary: NpmUpdateSummary = {
      currentHead: this.currentHeadShort,
      fresh: this.freshStatus,
      latestVersion: this.latestVersion,
      packageSpec: this.packageSpec,
      provider: this.options.provider,
      runDir: this.runDir,
      update: {
        linux: { status: this.updateStatus.linux, version: this.updateVersion.linux },
        macos: { status: this.updateStatus.macos, version: this.updateVersion.macos },
        windows: { status: this.updateStatus.windows, version: this.updateVersion.windows },
      },
      updateExpected: this.updateExpectedNeedle,
      updateTarget: this.updateTargetEffective,
    };
    const summaryPath = path.join(this.runDir, "summary.json");
    await writeJson(summaryPath, summary);
    return summaryPath;
  }
}

await new NpmUpdateSmoke(parseArgs(process.argv.slice(2))).run().catch((error: unknown) => {
  die(error instanceof Error ? error.message : String(error));
});
