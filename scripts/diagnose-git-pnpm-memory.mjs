#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Run Git clone/fetch/checkout and pnpm setup as independently limited Docker phases.
 *
 * The diagnostic intentionally uses a real GitHub remote for the production path. Its
 * local bare control is separate, because local upload-pack defaults differ from GitHub.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const defaultBaseSha = "977e0b64a12152a2e112634c1c32e8505db08234";
const defaultHeadSha = "34a3001388bb99fb4a041a73aad98631c4557634";
const defaultRepoUrl = "https://github.com/openclaw/openclaw.git";

function usage() {
  console.log(`Usage:
  node scripts/diagnose-git-pnpm-memory.mjs [options]

Description:
  Measures the exact GitHub partial clone (including its default checkout),
  immutable base/head fetches, explicit checkouts, Corepack, and pnpm install in
  separate Docker cgroups. A paired object-complete shallow
  local-bare controls show why a shallow server remains unsafe even when it
  advertises filters. A complete two-commit fixture is the bounded local test
  alternative. No phase is retried.

Options:
  --repo-url <https-url>       Git repository (default: ${defaultRepoUrl})
  --base-sha <40-hex>          Base commit (default: ${defaultBaseSha})
  --head-sha <40-hex>          Immutable head commit (default: ${defaultHeadSha})
  --node-image <image>         Docker base image (default: node:24.15.0-bookworm)
  --pnpm-version <version>     Corepack pnpm version (default: 11.2.2)
  --cpus <count>               Per-phase CPU quota (default: 4; max: 64)
  --node-heap-mib <MiB>        Per-isolate V8 heap ceiling (default: 0; disabled)
  --memory <size>              Per-phase memory and swap limit (default: 8g; max: 16g)
  --pids-limit <count>         Per-phase PID limit (default: 1024; max: 4096)
  --timeout-seconds <seconds>  Per-phase timeout (default: 600; max: 3600)
  --output-dir <path>          Empty artifact directory (default: .artifacts/git-pnpm-memory/<run>)
  --skip-local-control         Skip paired shallow local-bare phases
  --skip-install               Stop after Git checkout and repository analysis
  --ignore-install-scripts     Pass --ignore-scripts to the measured install
  --include-build              Measure pnpm build after install
  --keep-workspace             Keep the named Docker volume for inspection
  --dry-run                    Print the phase plan without Docker changes
  -h, --help                   Show this help

Outputs:
  <output-dir>/summary.json records commands, wall time, maximum RSS, cgroup
  memory.current/peak/events, exit status/signal, disk and Git object sizes,
  process peaks, filter negotiation, and cleanup state. Each phase directory
  retains stdout, stderr, GNU time -v output, process samples, and Git stats.
  Exit 0 means all production phases and the tiny object-complete local fixture pass;
  exit 1 means a measured phase failed; exit 2 means invocation/preflight failed.

Examples:
  node scripts/diagnose-git-pnpm-memory.mjs
  node scripts/diagnose-git-pnpm-memory.mjs --output-dir /tmp/openclaw-memory --skip-install
  node scripts/diagnose-git-pnpm-memory.mjs --memory 16g --include-build
  node scripts/diagnose-git-pnpm-memory.mjs --node-image node:24.13.0-bookworm --node-heap-mib 0
`);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 2;
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    repoUrl: defaultRepoUrl,
    baseSha: defaultBaseSha,
    headSha: defaultHeadSha,
    nodeImage: "node:24.15.0-bookworm",
    pnpmVersion: "11.2.2",
    cpus: 4,
    nodeHeapMiB: 0,
    memory: "8g",
    pidsLimit: 1024,
    timeoutSeconds: 600,
    outputDir: "",
    skipLocalControl: false,
    skipInstall: false,
    ignoreInstallScripts: false,
    includeBuild: false,
    keepWorkspace: false,
    dryRun: false,
  };
  const valueOptions = new Map([
    ["--repo-url", "repoUrl"],
    ["--base-sha", "baseSha"],
    ["--head-sha", "headSha"],
    ["--node-image", "nodeImage"],
    ["--pnpm-version", "pnpmVersion"],
    ["--cpus", "cpus"],
    ["--node-heap-mib", "nodeHeapMiB"],
    ["--memory", "memory"],
    ["--pids-limit", "pidsLimit"],
    ["--timeout-seconds", "timeoutSeconds"],
    ["--output-dir", "outputDir"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      usage();
      return null;
    }
    if (arg === "--skip-local-control") options.skipLocalControl = true;
    else if (arg === "--skip-install") options.skipInstall = true;
    else if (arg === "--ignore-install-scripts") options.ignoreInstallScripts = true;
    else if (arg === "--include-build") options.includeBuild = true;
    else if (arg === "--keep-workspace") options.keepWorkspace = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (valueOptions.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      options[valueOptions.get(arg)] = value;
      index += 1;
    } else {
      fail(`unknown option: ${arg}`);
    }
  }
  options.pidsLimit = Number(options.pidsLimit);
  options.timeoutSeconds = Number(options.timeoutSeconds);
  options.cpus = Number(options.cpus);
  options.nodeHeapMiB = Number(options.nodeHeapMiB);
  validateOptions(options);
  return options;
}

function validateOptions(options) {
  if (!/^https:\/\/[^\s/@]+(?:\/[^\s]*)?$/u.test(options.repoUrl)) {
    fail("--repo-url must be an HTTPS URL without embedded credentials");
  }
  for (const [name, value] of [
    ["--base-sha", options.baseSha],
    ["--head-sha", options.headSha],
  ]) {
    if (!/^[0-9a-f]{40}$/iu.test(value)) fail(`${name} must be a full 40-hex commit`);
  }
  if (!/^[A-Za-z0-9._/@:+-]+$/u.test(options.nodeImage)) fail("invalid --node-image");
  if (!/^[0-9A-Za-z.+-]+$/u.test(options.pnpmVersion)) fail("invalid --pnpm-version");
  if (!Number.isInteger(options.cpus) || options.cpus < 1 || options.cpus > 64) {
    fail("--cpus must be an integer between 1 and 64");
  }
  if (
    !Number.isInteger(options.nodeHeapMiB) ||
    options.nodeHeapMiB < 0 ||
    options.nodeHeapMiB > 12 * 1024
  ) {
    fail("--node-heap-mib must be 0 or an integer no greater than 12288");
  }
  const memoryMatch = /^(\d+)([gm])$/iu.exec(options.memory);
  if (!memoryMatch) fail("--memory must use an integer g or m suffix");
  const memoryMiB = Number(memoryMatch[1]) * (memoryMatch[2].toLowerCase() === "g" ? 1024 : 1);
  if (memoryMiB < 512 || memoryMiB > 16 * 1024) fail("--memory must be between 512m and 16g");
  if (!Number.isInteger(options.pidsLimit) || options.pidsLimit < 64 || options.pidsLimit > 4096) {
    fail("--pids-limit must be an integer between 64 and 4096");
  }
  if (
    !Number.isInteger(options.timeoutSeconds) ||
    options.timeoutSeconds < 30 ||
    options.timeoutSeconds > 3600
  ) {
    fail("--timeout-seconds must be an integer between 30 and 3600");
  }
}

function phasePlan(options) {
  const phases = [
    "github-clone",
    "github-fetch-base",
    "github-checkout-base",
    "github-fetch-head",
    "github-checkout-head",
    "repository-analysis",
  ];
  if (!options.skipLocalControl) {
    phases.push(
      "local-fixture-seed",
      "local-unfiltered-clone",
      "local-unfiltered-fetch",
      "local-unfiltered-checkout",
      "local-filtered-clone",
      "local-filtered-fetch",
      "local-filtered-checkout",
      "local-light-clone",
      "local-light-fetch",
      "local-light-checkout",
    );
  }
  if (!options.skipInstall) phases.push("corepack-setup", "pnpm-install");
  if (options.includeBuild && !options.skipInstall) phases.push("pnpm-build");
  return phases;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? "pipe",
    timeout: options.timeout,
    env: options.env ?? process.env,
  });
  if (options.allowFailure !== true && (result.error || result.status !== 0)) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function docker(args, options = {}) {
  return run("docker", args, options);
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readArtifactText(file) {
  try {
    return fs.lstatSync(file).isFile() ? fs.readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

function parseKeyValues(text) {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/u))
      .filter((parts) => parts.length === 2 && /^\d+$/u.test(parts[1]))
      .map(([key, value]) => [key, Number(value)]),
  );
}

function parseElapsed(value) {
  const parts = value.trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? null;
}

function parseTimeVerbose(text) {
  const rss = /Maximum resident set size \(kbytes\):\s*(\d+)/u.exec(text);
  const elapsed = /Elapsed \(wall clock\) time \(h:mm:ss or m:ss\):\s*([^\n]+)/u.exec(text);
  const signal = /Command terminated by signal (\d+)/u.exec(text);
  return {
    wallSeconds: elapsed ? parseElapsed(elapsed[1]) : null,
    maxRssKiB: rss ? Number(rss[1]) : null,
    signal: signal ? Number(signal[1]) : null,
  };
}

function parseProcessSamples(text) {
  const totals = new Map();
  const peaks = { packObjects: 0, uploadPack: 0, git: 0, pnpm: 0 };
  const threadPeaks = { packObjects: 0, uploadPack: 0, git: 0, pnpm: 0 };
  for (const line of text.trim().split("\n")) {
    const [sample, , , , rssRaw, threadsRaw, command = "", args = ""] = line.split("\t", 8);
    const rss = Number(rssRaw);
    const threads = Number(threadsRaw);
    if (!sample || !Number.isFinite(rss)) continue;
    totals.set(sample, (totals.get(sample) ?? 0) + rss);
    const rendered = `${command} ${args}`;
    for (const [category, matches] of [
      ["packObjects", /pack-objects/u.test(rendered)],
      ["uploadPack", /upload-pack/u.test(rendered)],
      ["git", /\bgit\b/u.test(rendered)],
      ["pnpm", /\bpnpm\b/u.test(rendered)],
    ]) {
      if (!matches) continue;
      peaks[category] = Math.max(peaks[category], rss);
      if (Number.isFinite(threads)) {
        threadPeaks[category] = Math.max(threadPeaks[category], threads);
      }
    }
  }
  return {
    sampledTotalRssPeakKiB: Math.max(0, ...totals.values()),
    processPeaksKiB: peaks,
    processThreadPeaks: threadPeaks,
  };
}

function numericFile(directory, name) {
  const value = readArtifactText(path.join(directory, name)).trim();
  return /^\d+$/u.test(value) ? Number(value) : null;
}

function collectPhaseResult({ name, directory, command, state, startResult }) {
  const eventsBefore = parseKeyValues(
    readArtifactText(path.join(directory, "memory.events.before")),
  );
  const eventsAfter = parseKeyValues(readArtifactText(path.join(directory, "memory.events.after")));
  const eventDelta = Object.fromEntries(
    [...new Set([...Object.keys(eventsBefore), ...Object.keys(eventsAfter)])].map((key) => [
      key,
      (eventsAfter[key] ?? 0) - (eventsBefore[key] ?? 0),
    ]),
  );
  const time = parseTimeVerbose(readArtifactText(path.join(directory, "time.txt")));
  const processes = parseProcessSamples(
    readArtifactText(path.join(directory, "process-samples.tsv")),
  );
  const pidsEventsBefore = parseKeyValues(
    readArtifactText(path.join(directory, "pids.events.before")),
  );
  const pidsEventsAfter = parseKeyValues(
    readArtifactText(path.join(directory, "pids.events.after")),
  );
  const stderr = readArtifactText(path.join(directory, "stderr.log"));
  const exitCode = numericFile(directory, "exit-code") ?? state.ExitCode ?? startResult.status;
  return {
    name,
    command,
    exitCode,
    signal: time.signal,
    oomKilled: state.OOMKilled === true,
    dockerError: startResult.error?.message ?? null,
    wallSeconds: time.wallSeconds,
    maxRssKiB: time.maxRssKiB,
    memoryCurrentBytes: numericFile(directory, "memory.current.after"),
    memoryPeakBytes: numericFile(directory, "memory.peak.after"),
    memoryEvents: eventsAfter,
    memoryEventDelta: eventDelta,
    pidsEvents: pidsEventsAfter,
    pidsEventDelta: Object.fromEntries(
      [...new Set([...Object.keys(pidsEventsBefore), ...Object.keys(pidsEventsAfter)])].map(
        (key) => [key, (pidsEventsAfter[key] ?? 0) - (pidsEventsBefore[key] ?? 0)],
      ),
    ),
    diskBytes: numericFile(directory, "disk-bytes"),
    nodeModulesBytes: numericFile(directory, "node-modules-bytes"),
    gitPackBytes: numericFile(directory, "git-pack-bytes"),
    filterNegotiated: /(?:clone>|fetch>|git<).*filter blob:none/u.test(
      readArtifactText(path.join(directory, "git-trace.log")),
    ),
    filterWarning: /filtering not recognized by server/iu.test(stderr),
    lingeringProcesses: readArtifactText(path.join(directory, "lingering-processes.txt"))
      .trim()
      .split("\n")
      .filter(Boolean),
    ...processes,
    artifacts: path.relative(repoRoot, directory),
  };
}

function renderCommand(command) {
  return command
    .map((part) => (/^[A-Za-z0-9_./:=+@,-]+$/u.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;
  const runId = `${new Date()
    .toISOString()
    .replace(/[-:.TZ]/gu, "")
    .slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  options.outputDir = path.resolve(
    repoRoot,
    options.outputDir || path.join(".artifacts", "git-pnpm-memory", runId),
  );
  const plannedPhases = phasePlan(options);
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          limits: {
            memory: options.memory,
            memorySwap: options.memory,
            pids: options.pidsLimit,
            timeoutSeconds: options.timeoutSeconds,
            retries: 0,
            cpus: options.cpus,
            nodeHeapMiB: options.nodeHeapMiB,
          },
          repoUrl: options.repoUrl,
          baseSha: options.baseSha,
          headSha: options.headSha,
          nodeImage: options.nodeImage,
          pnpmVersion: options.pnpmVersion,
          ignoreInstallScripts: options.ignoreInstallScripts,
          outputDir: options.outputDir,
          phases: plannedPhases,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (fs.existsSync(options.outputDir) && fs.readdirSync(options.outputDir).length > 0) {
    fail(`--output-dir must be empty: ${options.outputDir}`);
  }
  fs.mkdirSync(options.outputDir, { recursive: true });
  run("docker", ["version", "--format", "{{.Server.Version}}"]);
  const imageHash = createHash("sha256")
    .update(options.nodeImage)
    .update(readText(path.join(scriptDir, "lib", "git-pnpm-memory-phase.sh")))
    .digest("hex")
    .slice(0, 12);
  const image = `openclaw-git-pnpm-memory:${imageHash}`;
  const volume = `openclaw-git-pnpm-memory-${runId.toLowerCase()}`;
  const label = `openclaw.git-pnpm-memory.run=${runId}`;
  const containers = new Set();
  const phases = [];
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const container of containers) {
      docker(["rm", "--force", container], { allowFailure: true });
    }
    if (!options.keepWorkspace) docker(["volume", "rm", "--force", volume], { allowFailure: true });
  };
  // Cleanup must survive preflight, Docker, and result-parsing failures; otherwise
  // the diagnostic itself could leave the exact pack/install work it is policing.
  process.once("exit", cleanup);
  const onSignal = (signal) => {
    cleanup();
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  console.log(`Building clean diagnostic image ${image} from ${options.nodeImage}`);
  docker(
    [
      "build",
      "--pull",
      "--no-cache",
      "--build-arg",
      `NODE_IMAGE=${options.nodeImage}`,
      "--file",
      path.join("scripts", "docker", "git-pnpm-memory.Dockerfile"),
      "--tag",
      image,
      ".",
    ],
    { stdio: "inherit", timeout: 15 * 60 * 1000 },
  );
  docker(["volume", "create", "--label", label, volume]);

  const runPhase = (
    name,
    command,
    { gitPath = "", diskPath = "", env = {}, timeoutSeconds = options.timeoutSeconds } = {},
  ) => {
    const phaseDirectory = path.join(options.outputDir, name);
    fs.mkdirSync(phaseDirectory, { recursive: true });
    const container = `${volume}-${name}`.slice(0, 120);
    containers.add(container);
    const createArgs = [
      "create",
      "--init",
      "--name",
      container,
      "--label",
      label,
      "--memory",
      options.memory,
      "--memory-swap",
      options.memory,
      "--cpus",
      String(options.cpus),
      "--pids-limit",
      String(options.pidsLimit),
      "--volume",
      `${volume}:/work`,
      "--env",
      `PHASE_NAME=${name}`,
      "--env",
      `PHASE_TIMEOUT_SECONDS=${timeoutSeconds}`,
      "--env",
      "PHASE_RESULT_DIR=/phase-results",
      "--env",
      `DIAG_GIT_PATH=${gitPath}`,
      "--env",
      `DIAG_DISK_PATH=${diskPath}`,
      "--env",
      "HOME=/work/home",
      "--env",
      "COREPACK_HOME=/work/corepack",
      "--env",
      "PNPM_HOME=/work/pnpm-home",
      "--env",
      "PNPM_STORE_DIR=/work/pnpm-store",
      "--env",
      "PATH=/work/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      ...(options.nodeHeapMiB > 0
        ? ["--env", `NODE_OPTIONS=--max-old-space-size=${options.nodeHeapMiB}`]
        : []),
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      image,
      "/usr/local/bin/openclaw-git-pnpm-memory-phase",
      ...command,
    ];
    console.log(`\n[${name}] ${renderCommand(command)}`);
    docker(createArgs);
    const startResult = docker(["start", "--attach", container], {
      allowFailure: true,
      stdio: "inherit",
      timeout: (timeoutSeconds + 45) * 1000,
    });
    if (startResult.error) docker(["kill", container], { allowFailure: true });
    // Repository lifecycle scripts never see a host bind mount. Copy the
    // completed evidence out only after the measured container has stopped.
    docker(["cp", `${container}:/phase-results/.`, phaseDirectory]);
    const inspect = docker(["inspect", "--format", "{{json .State}}", container], {
      allowFailure: true,
    });
    let state = {};
    try {
      state = JSON.parse(String(inspect.stdout).trim() || "{}");
    } catch {
      state = {};
    }
    const result = collectPhaseResult({
      name,
      directory: phaseDirectory,
      command,
      state,
      startResult,
    });
    const resultPath = path.join(phaseDirectory, "result.json");
    if (fs.existsSync(resultPath) && !fs.lstatSync(resultPath).isFile()) {
      throw new Error(`refusing non-file phase result path: ${resultPath}`);
    }
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    phases.push(result);
    const removal = docker(["rm", "--force", container], { allowFailure: true });
    if (removal.status === 0) containers.delete(container);
    const peakMiB =
      result.memoryPeakBytes === null
        ? "unknown"
        : (result.memoryPeakBytes / 1024 / 1024).toFixed(1);
    console.log(
      `[${name}] exit=${result.exitCode} wall=${result.wallSeconds ?? "unknown"}s maxRSS=${result.maxRssKiB ?? "unknown"}KiB cgroupPeak=${peakMiB}MiB`,
    );
    return result;
  };

  const traceEnv = () => ({ GIT_TRACE_PACKET: "/phase-results/git-trace.log" });
  // Keep clone's implicit default checkout because experiment A specifies this
  // production command exactly; base/head checkouts are still measured explicitly.
  const githubClone = runPhase(
    "github-clone",
    [
      "git",
      "clone",
      "--filter=blob:none",
      "--depth=1",
      "--single-branch",
      options.repoUrl,
      "/work/github",
    ],
    { gitPath: "/work/github", diskPath: "/work/github", env: traceEnv("github-clone") },
  );
  if (githubClone.exitCode === 0) {
    const baseFetch = runPhase(
      "github-fetch-base",
      [
        "git",
        "-C",
        "/work/github",
        "fetch",
        "origin",
        `+${options.baseSha}:refs/remotes/repro/base`,
      ],
      { gitPath: "/work/github", diskPath: "/work/github", env: traceEnv("github-fetch-base") },
    );
    if (baseFetch.exitCode === 0) {
      runPhase(
        "github-checkout-base",
        ["git", "-C", "/work/github", "checkout", "--detach", "refs/remotes/repro/base"],
        {
          gitPath: "/work/github",
          diskPath: "/work/github",
          env: traceEnv("github-checkout-base"),
        },
      );
    }
    const headFetch = runPhase(
      "github-fetch-head",
      [
        "git",
        "-C",
        "/work/github",
        "fetch",
        "origin",
        `+${options.headSha}:refs/remotes/repro/pr-head`,
      ],
      { gitPath: "/work/github", diskPath: "/work/github", env: traceEnv("github-fetch-head") },
    );
    if (headFetch.exitCode === 0) {
      runPhase(
        "github-checkout-head",
        ["git", "-C", "/work/github", "checkout", "--detach", "refs/remotes/repro/pr-head"],
        {
          gitPath: "/work/github",
          diskPath: "/work/github",
          env: traceEnv("github-checkout-head"),
        },
      );
      runPhase("repository-analysis", ["true"], {
        gitPath: "/work/github",
        diskPath: "/work/github",
      });
    }
  }

  if (!options.skipLocalControl) {
    const seedScript = [
      "set -euo pipefail",
      "rm -rf /work/local-unfiltered.git /work/local-filtered.git",
      "git init --bare /work/local-unfiltered.git",
      'git -C /work/local-unfiltered.git remote add origin "$DIAG_REPO_URL"',
      // The local server must own the blobs it packs. A blobless bare promisor
      // disables lazy fetch inside upload-pack and tests missing objects instead.
      `git -C /work/local-unfiltered.git fetch --no-tags --depth=1 origin +${options.baseSha}:refs/heads/main +${options.headSha}:refs/pull/1/head`,
      "git -C /work/local-unfiltered.git symbolic-ref HEAD refs/heads/main",
      "cp -a /work/local-unfiltered.git /work/local-filtered.git",
      "git -C /work/local-filtered.git config uploadpack.allowFilter true",
      "rm -rf /work/local-light-source /work/local-light.git",
      "git init --initial-branch=main /work/local-light-source",
      "git -C /work/local-light-source config user.name 'OpenClaw diagnostics'",
      "git -C /work/local-light-source config user.email diagnostics@openclaw.invalid",
      "printf 'base\\n' > /work/local-light-source/fixture.txt",
      "git -C /work/local-light-source add fixture.txt",
      "git -C /work/local-light-source commit -m base",
      "git clone --bare /work/local-light-source /work/local-light.git",
      "git -C /work/local-light.git config uploadpack.allowFilter true",
      "printf 'head\\n' >> /work/local-light-source/fixture.txt",
      "git -C /work/local-light-source commit -am head",
      "git -C /work/local-light-source push /work/local-light.git HEAD:refs/pull/1/head",
    ].join("\n");
    const seed = runPhase("local-fixture-seed", ["bash", "-lc", seedScript], {
      gitPath: "/work/local-unfiltered.git",
      diskPath: "/work/local-unfiltered.git",
      env: { ...traceEnv("local-fixture-seed"), DIAG_REPO_URL: options.repoUrl },
    });
    if (seed.exitCode === 0) {
      for (const [variant, remote] of [
        ["unfiltered", "file:///work/local-unfiltered.git"],
        ["filtered", "file:///work/local-filtered.git"],
      ]) {
        const cloneName = `local-${variant}-clone`;
        const checkoutPath = `/work/${variant}-checkout`;
        const diagnosticTimeout = Math.min(options.timeoutSeconds, 120);
        const clone = runPhase(
          cloneName,
          [
            "git",
            "clone",
            "--filter=blob:none",
            "--depth=1",
            "--single-branch",
            remote,
            checkoutPath,
          ],
          {
            gitPath: checkoutPath,
            diskPath: checkoutPath,
            env: traceEnv(cloneName),
            timeoutSeconds: diagnosticTimeout,
          },
        );
        if (clone.exitCode !== 0) continue;
        const fetchName = `local-${variant}-fetch`;
        const fetch = runPhase(
          fetchName,
          [
            "git",
            "-C",
            checkoutPath,
            "fetch",
            "origin",
            "+refs/pull/1/head:refs/remotes/repro/pr-head",
          ],
          {
            gitPath: checkoutPath,
            diskPath: checkoutPath,
            env: traceEnv(fetchName),
            timeoutSeconds: diagnosticTimeout,
          },
        );
        if (fetch.exitCode === 0) {
          const checkoutName = `local-${variant}-checkout`;
          runPhase(
            checkoutName,
            ["git", "-C", checkoutPath, "checkout", "--detach", "refs/remotes/repro/pr-head"],
            {
              gitPath: checkoutPath,
              diskPath: checkoutPath,
              env: traceEnv(checkoutName),
              timeoutSeconds: diagnosticTimeout,
            },
          );
        }
      }
      const lightClone = runPhase(
        "local-light-clone",
        [
          "git",
          "clone",
          "--filter=blob:none",
          "--depth=1",
          "--single-branch",
          "file:///work/local-light.git",
          "/work/light-checkout",
        ],
        {
          gitPath: "/work/light-checkout",
          diskPath: "/work/light-checkout",
          env: traceEnv("local-light-clone"),
        },
      );
      if (lightClone.exitCode === 0) {
        const lightFetch = runPhase(
          "local-light-fetch",
          [
            "git",
            "-C",
            "/work/light-checkout",
            "fetch",
            "origin",
            "+refs/pull/1/head:refs/remotes/repro/pr-head",
          ],
          {
            gitPath: "/work/light-checkout",
            diskPath: "/work/light-checkout",
            env: traceEnv("local-light-fetch"),
          },
        );
        if (lightFetch.exitCode === 0) {
          runPhase(
            "local-light-checkout",
            [
              "git",
              "-C",
              "/work/light-checkout",
              "checkout",
              "--detach",
              "refs/remotes/repro/pr-head",
            ],
            {
              gitPath: "/work/light-checkout",
              diskPath: "/work/light-checkout",
              env: traceEnv("local-light-checkout"),
            },
          );
        }
      }
    }
  }

  if (
    !options.skipInstall &&
    phases.some((phase) => phase.name === "github-checkout-head" && phase.exitCode === 0)
  ) {
    const corepack = runPhase(
      "corepack-setup",
      [
        "bash",
        "-c",
        `mkdir -p /work/bin /work/corepack /work/home /work/pnpm-home /work/pnpm-store && corepack enable --install-directory /work/bin && corepack prepare ${JSON.stringify(`pnpm@${options.pnpmVersion}`)} --activate`,
      ],
      { diskPath: "/work/corepack" },
    );
    if (corepack.exitCode === 0) {
      const install = runPhase(
        "pnpm-install",
        [
          "bash",
          "-c",
          `cd /work/github && exec pnpm install --frozen-lockfile${options.ignoreInstallScripts ? " --ignore-scripts" : ""}`,
        ],
        { gitPath: "/work/github", diskPath: "/work/github" },
      );
      if (options.includeBuild && install.exitCode === 0) {
        runPhase("pnpm-build", ["bash", "-c", "cd /work/github && exec pnpm build"], {
          gitPath: "/work/github",
          diskPath: "/work/github",
        });
      }
    }
  }

  const required = new Set([
    "github-clone",
    "github-fetch-base",
    "github-checkout-base",
    "github-fetch-head",
    "github-checkout-head",
    "repository-analysis",
    ...(!options.skipLocalControl
      ? ["local-light-clone", "local-light-fetch", "local-light-checkout"]
      : []),
    ...(!options.skipInstall ? ["corepack-setup", "pnpm-install"] : []),
    ...(options.includeBuild && !options.skipInstall ? ["pnpm-build"] : []),
  ]);
  cleanup();
  const runningContainers = docker(["ps", "--filter", `label=${label}`, "--format", "{{.ID}}"], {
    allowFailure: true,
  })
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const remainingContainers = docker(
    ["ps", "--all", "--filter", `label=${label}`, "--format", "{{.ID}}"],
    { allowFailure: true },
  )
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const remainingVolumes = docker(
    ["volume", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}"],
    { allowFailure: true },
  )
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const failures = phases.filter((phase) => required.has(phase.name) && phase.exitCode !== 0);
  const missing = [...required].filter((name) => !phases.some((phase) => phase.name === name));
  const resourceViolations = phases.filter(
    (phase) =>
      required.has(phase.name) &&
      (phase.oomKilled ||
        (phase.memoryEventDelta.max ?? 0) > 0 ||
        (phase.memoryEventDelta.oom ?? 0) > 0 ||
        (phase.memoryEventDelta.oom_kill ?? 0) > 0 ||
        (phase.pidsEventDelta.max ?? 0) > 0 ||
        phase.lingeringProcesses.length > 0),
  );
  const summary = {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    inputs: {
      repoUrl: options.repoUrl,
      baseSha: options.baseSha,
      headSha: options.headSha,
      nodeImage: options.nodeImage,
      pnpmVersion: options.pnpmVersion,
    },
    limits: {
      memory: options.memory,
      memorySwap: options.memory,
      pids: options.pidsLimit,
      timeoutSeconds: options.timeoutSeconds,
      retries: 0,
      cpus: options.cpus,
      nodeHeapMiB: options.nodeHeapMiB,
    },
    phases,
    cleanup: {
      workspaceKept: options.keepWorkspace,
      volume,
      runningContainers,
      remainingContainers,
      remainingVolumes,
    },
    verdict:
      failures.length === 0 &&
      missing.length === 0 &&
      resourceViolations.length === 0 &&
      remainingContainers.length === 0 &&
      (options.keepWorkspace || remainingVolumes.length === 0)
        ? "pass"
        : "fail",
    failedRequiredPhases: failures.map((phase) => phase.name),
    missingRequiredPhases: missing,
    resourceViolationPhases: resourceViolations.map((phase) => phase.name),
  };
  fs.writeFileSync(
    path.join(options.outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(`\nSummary: ${path.join(options.outputDir, "summary.json")}`);
  if (summary.verdict !== "pass") process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  if (process.exitCode !== 2) process.exitCode = 2;
  console.error(error instanceof Error ? error.message : String(error));
}
