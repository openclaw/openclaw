#!/usr/bin/env -S pnpm tsx
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
  resolveWindowsProviderAuth,
  run,
  say,
  startHostServer,
  writeJson,
  type HostServer,
  type PackageArtifact,
  type Platform,
  type Provider,
  type ProviderAuth,
} from "./common.ts";
import { runWindowsBackgroundPowerShell } from "./guest-transports.ts";
import { linuxUpdateScript, macosUpdateScript, windowsUpdateScript } from "./npm-update-scripts.ts";
import { ensureVmRunning, resolveUbuntuVmName } from "./parallels-vm.ts";

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
  durationMs: number;
  label: string;
  logPath: string;
  promise: Promise<number>;
  startedAt: number;
}

interface UpdateJobContext {
  append(chunk: string | Uint8Array): void;
  logPath: string;
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
  timings: Array<{
    durationMs: number;
    label: string;
    logPath: string;
    phase: "fresh" | "update";
    status: string;
  }>;
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
  private windowsAuth: ProviderAuth;
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
  private timings: NpmUpdateSummary["timings"] = [];

  constructor(private options: NpmUpdateOptions) {
    this.auth = resolveProviderAuth({
      apiKeyEnv: options.apiKeyEnv,
      modelId: options.modelId,
      provider: options.provider,
    });
    this.windowsAuth = resolveWindowsProviderAuth({
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
        this.linuxVm = resolveUbuntuVmName(linuxVmDefault);
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
      this.recordTiming("fresh", job, status);
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
    const auth = this.authForPlatform(platform);
    const args = [
      "exec",
      "tsx",
      `scripts/e2e/parallels/${platform}-smoke.ts`,
      "--mode",
      "fresh",
      "--provider",
      this.options.provider,
      "--model",
      auth.modelId,
      "--api-key-env",
      auth.apiKeyEnv,
      "--target-package-spec",
      this.packageSpec,
      "--json",
      ...extraArgs,
    ];
    const job: Job = {
      done: false,
      durationMs: 0,
      label,
      logPath,
      promise: Promise.resolve(1),
      startedAt: Date.now(),
    };
    job.promise = this.spawnLogged("pnpm", args, logPath, env).finally(() => {
      job.durationMs = Date.now() - job.startedAt;
      job.done = true;
    });
    return job;
  }

  private async prepareUpdateTarget(): Promise<void> {
    if (!this.options.updateTarget || this.options.updateTarget === "local-main") {
      this.artifact = await packOpenClaw({
        destination: this.tgzDir,
        requireControlUi: true,
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
      ensureVmRunning(macosVm);
      jobs.push(this.spawnUpdate("macOS", "macos", (ctx) => this.runMacosUpdate(ctx)));
    }
    if (this.options.platforms.has("windows")) {
      ensureVmRunning(windowsVm);
      jobs.push(this.spawnUpdate("Windows", "windows", (ctx) => this.runWindowsUpdate(ctx)));
    }
    if (this.options.platforms.has("linux")) {
      ensureVmRunning(this.linuxVm);
      jobs.push(this.spawnUpdate("Linux", "linux", (ctx) => this.runLinuxUpdate(ctx)));
    }
    await this.monitorJobs("update", jobs);
    for (const job of jobs) {
      const platform = this.platformFromLabel(job.label);
      const status = (await job.promise) === 0 ? "pass" : "fail";
      this.updateStatus[platform] = status;
      this.updateVersion[platform] = await this.extractLastVersion(job.logPath);
      this.recordTiming("update", job, status);
      if (status !== "pass") {
        this.dumpLogTail(job.logPath);
        die(`${job.label} update failed`);
      }
    }
  }

  private spawnUpdate(
    label: string,
    platform: Platform,
    fn: (ctx: UpdateJobContext) => Promise<void> | void,
  ): Job {
    const logPath = path.join(this.runDir, `${platform}-update.log`);
    const job: Job = {
      done: false,
      durationMs: 0,
      label,
      logPath,
      promise: Promise.resolve(1),
      startedAt: Date.now(),
    };
    job.promise = (async () => {
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
        await fn({ append, logPath });
        await writeFile(logPath, log, "utf8");
        return 0;
      } catch (error) {
        append(`${error instanceof Error ? error.message : String(error)}\n`);
        await writeFile(logPath, log, "utf8");
        return 1;
      } finally {
        clearTimeout(timeout);
      }
    })().finally(() => {
      job.durationMs = Date.now() - job.startedAt;
      job.done = true;
    });
    return job;
  }

  private async runMacosUpdate(ctx: UpdateJobContext): Promise<void> {
    await this.guestMacos(this.updateScript("macos"), updateTimeoutSeconds * 1000, ctx);
  }

  private runWindowsUpdate(ctx: UpdateJobContext): Promise<void> {
    return this.guestWindows(this.updateScript("windows"), updateTimeoutSeconds * 1000, ctx);
  }

  private async runLinuxUpdate(ctx: UpdateJobContext): Promise<void> {
    await this.guestLinux(this.updateScript("linux"), updateTimeoutSeconds * 1000, ctx);
  }

  private updateScript(platform: Platform): string {
    const input = {
      auth: this.authForPlatform(platform),
      expectedNeedle: this.updateExpectedNeedle,
      updateTarget: this.updateTargetEffective,
    };
    switch (platform) {
      case "macos":
        return macosUpdateScript(input);
      case "windows":
        return windowsUpdateScript(input);
      case "linux":
        return linuxUpdateScript(input);
    }
    return die("unsupported platform");
  }

  private authForPlatform(platform: Platform): ProviderAuth {
    return platform === "windows" ? this.windowsAuth : this.auth;
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

  private async guestMacos(
    script: string,
    timeoutMs: number,
    ctx: UpdateJobContext,
  ): Promise<void> {
    const scriptPath = this.writeGuestScript(
      macosVm,
      script,
      "openclaw-parallels-npm-update-macos",
    );
    const macosExecArgs = this.resolveMacosUpdateExecArgs(ctx);
    const sudoUserArgIndex = macosExecArgs.indexOf("-u");
    const sudoUser =
      sudoUserArgIndex >= 0 && sudoUserArgIndex + 1 < macosExecArgs.length
        ? macosExecArgs[sudoUserArgIndex + 1]
        : "";
    if (sudoUser) {
      run("prlctl", ["exec", macosVm, "/usr/sbin/chown", sudoUser, scriptPath], {
        timeoutMs: 30_000,
      });
    }
    try {
      const status = await this.runStreamingToJobLog(
        "prlctl",
        ["exec", macosVm, ...macosExecArgs, "/bin/bash", scriptPath],
        timeoutMs,
        ctx,
      );
      if (status !== 0) {
        throw new Error(`macOS update command failed with exit code ${status}`);
      }
    } finally {
      this.removeGuestScript(macosVm, scriptPath);
    }
  }

  private resolveMacosUpdateExecArgs(ctx: UpdateJobContext): string[] {
    const guestPath =
      "/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
    const currentUser = run("prlctl", ["exec", macosVm, "--current-user", "whoami"], {
      check: false,
      quiet: true,
      timeoutMs: 45_000,
    });
    const user = currentUser.stdout.trim().replaceAll("\r", "").split("\n").at(-1) ?? "";
    if (currentUser.status === 0 && /^[A-Za-z0-9._-]+$/.test(user)) {
      return ["--current-user", "/usr/bin/env", `PATH=${guestPath}`];
    }

    const fallbackUser = this.resolveMacosDesktopUser();
    if (!fallbackUser) {
      ctx.append(currentUser.stdout);
      ctx.append(currentUser.stderr);
      throw new Error("macOS desktop user unavailable before update phase");
    }
    ctx.append(
      `desktop user unavailable via Parallels --current-user; using root sudo fallback for ${fallbackUser}\n`,
    );
    const home = this.resolveMacosDesktopHome(fallbackUser);
    return [
      "/usr/bin/sudo",
      "-H",
      "-u",
      fallbackUser,
      "/usr/bin/env",
      `HOME=${home}`,
      `USER=${fallbackUser}`,
      `LOGNAME=${fallbackUser}`,
      `PATH=${guestPath}`,
    ];
  }

  private resolveMacosDesktopUser(): string {
    const consoleUser =
      run("prlctl", ["exec", macosVm, "/usr/bin/stat", "-f", "%Su", "/dev/console"], {
        check: false,
        quiet: true,
        timeoutMs: 30_000,
      })
        .stdout.trim()
        .replaceAll("\r", "")
        .split("\n")
        .at(-1) ?? "";
    if (
      /^[A-Za-z0-9._-]+$/.test(consoleUser) &&
      consoleUser !== "root" &&
      consoleUser !== "loginwindow"
    ) {
      return consoleUser;
    }
    const users = run(
      "prlctl",
      ["exec", macosVm, "/usr/bin/dscl", ".", "-list", "/Users", "NFSHomeDirectory"],
      { check: false, quiet: true, timeoutMs: 30_000 },
    ).stdout.replaceAll("\r", "");
    for (const line of users.split("\n")) {
      const [user, home] = line.trim().split(/\s+/);
      if (
        user &&
        home?.startsWith("/Users/") &&
        !user.startsWith("_") &&
        user !== "Shared" &&
        user !== ".localized"
      ) {
        return user;
      }
    }
    return "";
  }

  private resolveMacosDesktopHome(user: string): string {
    const output = run(
      "prlctl",
      ["exec", macosVm, "/usr/bin/dscl", ".", "-read", `/Users/${user}`, "NFSHomeDirectory"],
      { check: false, quiet: true, timeoutMs: 30_000 },
    ).stdout.replaceAll("\r", "");
    const match = /NFSHomeDirectory:\s*(\S+)/.exec(output);
    return match?.[1] ?? `/Users/${user}`;
  }

  private async guestWindows(
    script: string,
    timeoutMs: number,
    ctx: UpdateJobContext,
  ): Promise<void> {
    await runWindowsBackgroundPowerShell({
      append: (chunk) => ctx.append(chunk),
      label: "Windows update",
      script,
      timeoutMs,
      vmName: windowsVm,
    });
  }

  private async guestLinux(
    script: string,
    timeoutMs: number,
    ctx: UpdateJobContext,
  ): Promise<void> {
    const scriptPath = this.writeGuestScript(
      this.linuxVm,
      script,
      "openclaw-parallels-npm-update-linux",
    );
    try {
      const status = await this.runStreamingToJobLog(
        "prlctl",
        [
          "exec",
          this.linuxVm,
          "/usr/bin/env",
          "HOME=/root",
          "PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/snap/bin",
          "bash",
          scriptPath,
        ],
        timeoutMs,
        ctx,
      );
      if (status !== 0) {
        throw new Error(`Linux update command failed with exit code ${status}`);
      }
    } finally {
      this.removeGuestScript(this.linuxVm, scriptPath);
    }
  }

  private writeGuestScript(vm: string, script: string, prefix: string): string {
    const scriptPath = `/tmp/${prefix}-${process.pid}-${Date.now()}.sh`;
    const write = run("prlctl", ["exec", vm, "/usr/bin/tee", scriptPath], {
      check: false,
      input: script,
      quiet: true,
      timeoutMs: 120_000,
    });
    if (write.status !== 0) {
      throw new Error(`failed to write guest script ${scriptPath}: ${write.stderr.trim()}`);
    }
    const chmod = run("prlctl", ["exec", vm, "/bin/chmod", "755", scriptPath], {
      check: false,
      quiet: true,
      timeoutMs: 30_000,
    });
    if (chmod.status !== 0) {
      throw new Error(`failed to chmod guest script ${scriptPath}: ${chmod.stderr.trim()}`);
    }
    return scriptPath;
  }

  private removeGuestScript(vm: string, scriptPath: string): void {
    run("prlctl", ["exec", vm, "/bin/rm", "-f", scriptPath], {
      check: false,
      quiet: true,
      timeoutMs: 30_000,
    });
  }

  private async runStreamingToJobLog(
    command: string,
    args: string[],
    timeoutMs: number,
    ctx: UpdateJobContext,
  ): Promise<number> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: repoRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk: Buffer) => ctx.append(chunk));
      child.stderr.on("data", (chunk: Buffer) => ctx.append(chunk));

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      }, timeoutMs);

      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve(124);
          return;
        }
        resolve(code ?? (signal ? 128 : 1));
      });
    });
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

  private recordTiming(phase: "fresh" | "update", job: Job, status: string): void {
    this.timings.push({
      durationMs: job.durationMs || Date.now() - job.startedAt,
      label: job.label,
      logPath: job.logPath,
      phase,
      status,
    });
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
      timings: this.timings,
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
