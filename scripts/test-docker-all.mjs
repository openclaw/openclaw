import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_E2E_IMAGE = "openclaw-docker-e2e:local";
const DEFAULT_PARALLELISM = 10;
const DEFAULT_TAIL_PARALLELISM = 10;
const DEFAULT_FAILURE_TAIL_LINES = 80;
const DEFAULT_LANE_TIMEOUT_MS = 120 * 60 * 1000;
const DEFAULT_LANE_START_STAGGER_MS = 2_000;
const DEFAULT_RESOURCE_LIMITS = {
  docker: DEFAULT_PARALLELISM,
  live: 4,
  npm: 4,
  service: 5,
};

const bundledChannelLaneCommand =
  "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 pnpm test:docker:bundled-channel-deps";

function lane(name, command, options = {}) {
  return {
    command,
    name,
    resources: options.resources ?? [],
    weight: options.weight ?? 1,
  };
}

function liveLane(name, command, options = {}) {
  return lane(name, command, {
    resources: ["live", ...(options.resources ?? [])],
    weight: options.weight ?? 3,
  });
}

function npmLane(name, command, options = {}) {
  return lane(name, command, {
    resources: ["npm", ...(options.resources ?? [])],
    weight: options.weight ?? 2,
  });
}

function serviceLane(name, command, options = {}) {
  return lane(name, command, {
    resources: ["service", ...(options.resources ?? [])],
    weight: options.weight ?? 2,
  });
}

const bundledScenarioLanes = [
  npmLane(
    "bundled-channel-telegram",
    `OPENCLAW_BUNDLED_CHANNELS=telegram ${bundledChannelLaneCommand}`,
  ),
  npmLane(
    "bundled-channel-discord",
    `OPENCLAW_BUNDLED_CHANNELS=discord ${bundledChannelLaneCommand}`,
  ),
  npmLane("bundled-channel-slack", `OPENCLAW_BUNDLED_CHANNELS=slack ${bundledChannelLaneCommand}`),
  npmLane(
    "bundled-channel-feishu",
    `OPENCLAW_BUNDLED_CHANNELS=feishu ${bundledChannelLaneCommand}`,
  ),
  npmLane(
    "bundled-channel-memory-lancedb",
    `OPENCLAW_BUNDLED_CHANNELS=memory-lancedb ${bundledChannelLaneCommand}`,
  ),
  npmLane(
    "bundled-channel-update",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 pnpm test:docker:bundled-channel-deps",
  ),
  npmLane(
    "bundled-channel-root-owned",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 pnpm test:docker:bundled-channel-deps",
  ),
  npmLane(
    "bundled-channel-setup-entry",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 pnpm test:docker:bundled-channel-deps",
  ),
  npmLane(
    "bundled-channel-load-failure",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=1 pnpm test:docker:bundled-channel-deps",
  ),
];

const lanes = [
  liveLane("live-models", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-models", {
    weight: 4,
  }),
  liveLane("live-gateway", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-gateway", {
    weight: 4,
  }),
  liveLane(
    "live-cli-backend-claude",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-cli-backend:claude",
    { resources: ["npm"], weight: 3 },
  ),
  liveLane(
    "live-cli-backend-gemini",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-cli-backend:gemini",
    { resources: ["npm"], weight: 3 },
  ),
  serviceLane("openwebui", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openwebui", {
    weight: 5,
  }),
  serviceLane("onboard", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:onboard", {
    weight: 2,
  }),
  npmLane(
    "npm-onboard-channel-agent",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:npm-onboard-channel-agent",
    { resources: ["service"], weight: 3 },
  ),
  serviceLane("gateway-network", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:gateway-network"),
  serviceLane("mcp-channels", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:mcp-channels", {
    resources: ["npm"],
    weight: 3,
  }),
  lane("pi-bundle-mcp-tools", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:pi-bundle-mcp-tools"),
  serviceLane(
    "cron-mcp-cleanup",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:cron-mcp-cleanup",
    { resources: ["npm"], weight: 3 },
  ),
  npmLane("doctor-switch", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:doctor-switch", {
    weight: 3,
  }),
  npmLane("plugins", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins", { weight: 2 }),
  npmLane("plugin-update", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugin-update"),
  serviceLane("config-reload", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:config-reload"),
  ...bundledScenarioLanes,
  lane("openai-image-auth", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-image-auth"),
  lane("qr", "pnpm test:docker:qr"),
];

const exclusiveLanes = [
  serviceLane(
    "openai-web-search-minimal",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-web-search-minimal",
  ),
  liveLane(
    "live-codex-harness",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-codex-harness",
    { resources: ["npm"], weight: 3 },
  ),
  liveLane("live-codex-bind", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-codex-bind", {
    resources: ["npm"],
    weight: 3,
  }),
  liveLane(
    "live-cli-backend-codex",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-cli-backend:codex",
    { resources: ["npm"], weight: 3 },
  ),
  liveLane(
    "live-acp-bind-claude",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-acp-bind:claude",
    { resources: ["npm"], weight: 3 },
  ),
  liveLane(
    "live-acp-bind-codex",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-acp-bind:codex",
    { resources: ["npm"], weight: 3 },
  ),
  liveLane(
    "live-acp-bind-gemini",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-acp-bind:gemini",
    { resources: ["npm"], weight: 3 },
  ),
];

const tailLanes = exclusiveLanes;

function parsePositiveInt(raw, fallback, label) {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer. Got: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function parseNonNegativeInt(raw, fallback, label) {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer. Got: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function parseBool(raw, fallback) {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return !/^(?:0|false|no)$/i.test(raw);
}

function parseResourceLimit(env, resource, parallelism, fallback) {
  const envName = `OPENCLAW_DOCKER_ALL_${resource.toUpperCase()}_LIMIT`;
  return parsePositiveInt(env[envName], Math.min(parallelism, fallback), envName);
}

function parseSchedulerOptions(env, parallelism) {
  const weightLimit = parsePositiveInt(
    env.OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT,
    parallelism,
    "OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT",
  );
  return {
    resourceLimits: {
      docker: parseResourceLimit(env, "docker", parallelism, parallelism),
      live: parseResourceLimit(env, "live", parallelism, DEFAULT_RESOURCE_LIMITS.live),
      npm: parseResourceLimit(env, "npm", parallelism, DEFAULT_RESOURCE_LIMITS.npm),
      service: parseResourceLimit(env, "service", parallelism, DEFAULT_RESOURCE_LIMITS.service),
    },
    weightLimit,
  };
}

function laneWeight(poolLane) {
  return Math.max(1, poolLane.weight ?? 1);
}

function laneResources(poolLane) {
  return ["docker", ...(poolLane.resources ?? [])];
}

function laneSummary(poolLane) {
  const resources = laneResources(poolLane).join(",");
  return `${poolLane.name}(w=${laneWeight(poolLane)} r=${resources})`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function utcStampForPath() {
  return new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\..*$/, "Z");
}

function utcStamp() {
  return new Date().toISOString().replace(/\..*$/, "Z");
}

function appendExtension(env, extension) {
  const current = env.OPENCLAW_DOCKER_BUILD_EXTENSIONS ?? env.OPENCLAW_EXTENSIONS ?? "";
  const tokens = current.split(/\s+/).filter(Boolean);
  if (!tokens.includes(extension)) {
    tokens.push(extension);
  }
  env.OPENCLAW_DOCKER_BUILD_EXTENSIONS = tokens.join(" ");
}

function commandEnv(extra = {}) {
  return {
    ...process.env,
    ...extra,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runShellCommand({ command, env, label, logFile, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: ROOT_DIR,
      detached: process.platform !== "win32",
      env,
      stdio: logFile ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    activeChildren.add(child);
    let timedOut = false;
    let killTimer;
    const timeoutTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            if (stream) {
              stream.write(`\n==> [${label}] timeout after ${timeoutMs}ms; sending SIGTERM\n`);
            }
            terminateChild(child, "SIGTERM");
            killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), 10_000);
            killTimer.unref?.();
          }, timeoutMs)
        : undefined;
    timeoutTimer?.unref?.();

    let stream;
    if (logFile) {
      stream = fs.createWriteStream(logFile, { flags: "a" });
      stream.write(`==> [${label}] command: ${command}\n`);
      stream.write(`==> [${label}] started: ${utcStamp()}\n`);
      child.stdout.pipe(stream, { end: false });
      child.stderr.pipe(stream, { end: false });
    }

    child.on("close", (status, signal) => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      activeChildren.delete(child);
      const exitCode = typeof status === "number" ? status : signal ? 128 : 1;
      if (stream) {
        stream.write(`\n==> [${label}] finished: ${utcStamp()} status=${exitCode}\n`);
        stream.end();
      }
      resolve({ signal, status: exitCode, timedOut });
    });
  });
}

async function runForeground(label, command, env) {
  console.log(`==> ${label}`);
  const result = await runShellCommand({ command, env, label });
  if (result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status}`);
  }
}

async function runForegroundGroup(entries, env) {
  const results = await Promise.allSettled(
    entries.map(async ([label, command]) => {
      await runForeground(label, command, env);
    }),
  );
  const failures = results
    .map((result, index) => ({ result, entry: entries[index] }))
    .filter(({ result }) => result.status === "rejected");
  if (failures.length > 0) {
    throw new Error(
      failures
        .map(
          ({ result, entry }) => `${entry[0]}: ${result.reason?.message ?? String(result.reason)}`,
        )
        .join("\n"),
    );
  }
}

async function prepareBundledChannelPackage(baseEnv, logDir) {
  if (baseEnv.OPENCLAW_BUNDLED_CHANNEL_PACKAGE_TGZ) {
    console.log(`==> Bundled channel package: ${baseEnv.OPENCLAW_BUNDLED_CHANNEL_PACKAGE_TGZ}`);
    return;
  }

  const packDir = path.join(logDir, "bundled-channel-package");
  await mkdir(packDir, { recursive: true });
  const packScript = [
    "set -euo pipefail",
    "node --import tsx --input-type=module -e \"const { writePackageDistInventory } = await import('./src/infra/package-dist-inventory.ts'); await writePackageDistInventory(process.cwd());\"",
    "npm pack --silent --ignore-scripts --pack-destination /tmp/openclaw-pack >/tmp/openclaw-pack.out",
    "cat /tmp/openclaw-pack.out",
  ].join("\n");
  await runForeground(
    "Pack bundled channel package once from Docker E2E image",
    [
      "docker run --rm",
      "-e COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
      `-v ${shellQuote(packDir)}:/tmp/openclaw-pack`,
      shellQuote(baseEnv.OPENCLAW_DOCKER_E2E_IMAGE),
      "bash -lc",
      shellQuote(packScript),
    ].join(" "),
    baseEnv,
  );

  const packed = (await fs.promises.readdir(packDir))
    .filter((entry) => /^openclaw-.*\.tgz$/.test(entry))
    .toSorted()
    .at(-1);
  if (!packed) {
    throw new Error(`missing packed OpenClaw tarball in ${packDir}`);
  }
  baseEnv.OPENCLAW_BUNDLED_CHANNEL_PACKAGE_TGZ = path.join(packDir, packed);
  baseEnv.OPENCLAW_BUNDLED_CHANNEL_HOST_BUILD = "0";
  baseEnv.OPENCLAW_NPM_ONBOARD_PACKAGE_TGZ = baseEnv.OPENCLAW_BUNDLED_CHANNEL_PACKAGE_TGZ;
  baseEnv.OPENCLAW_NPM_ONBOARD_HOST_BUILD = "0";
  console.log(`==> Bundled channel package: ${baseEnv.OPENCLAW_BUNDLED_CHANNEL_PACKAGE_TGZ}`);
}

function laneEnv(name, baseEnv, logDir) {
  const env = {
    ...baseEnv,
  };
  if (!process.env.OPENCLAW_DOCKER_CLI_TOOLS_DIR) {
    env.OPENCLAW_DOCKER_CLI_TOOLS_DIR = path.join(logDir, `${name}-cli-tools`);
  }
  if (!process.env.OPENCLAW_DOCKER_CACHE_HOME_DIR) {
    env.OPENCLAW_DOCKER_CACHE_HOME_DIR = path.join(logDir, `${name}-cache`);
  }
  return env;
}

async function runLane(lane, baseEnv, logDir, timeoutMs) {
  const { command, name } = lane;
  const logFile = path.join(logDir, `${name}.log`);
  const env = laneEnv(name, baseEnv, logDir);
  await mkdir(env.OPENCLAW_DOCKER_CLI_TOOLS_DIR, { recursive: true });
  await mkdir(env.OPENCLAW_DOCKER_CACHE_HOME_DIR, { recursive: true });
  await fs.promises.writeFile(
    logFile,
    [
      `==> [${name}] cli tools dir: ${env.OPENCLAW_DOCKER_CLI_TOOLS_DIR}`,
      `==> [${name}] cache dir: ${env.OPENCLAW_DOCKER_CACHE_HOME_DIR}`,
      "",
    ].join("\n"),
  );
  console.log(`==> [${name}] start`);
  const startedAt = Date.now();
  const result = await runShellCommand({ command, env, label: name, logFile, timeoutMs });
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  if (result.status === 0) {
    console.log(`==> [${name}] pass ${elapsedSeconds}s`);
  } else {
    const timeoutLabel = result.timedOut ? " timeout" : "";
    console.error(
      `==> [${name}] fail${timeoutLabel} status=${result.status} ${elapsedSeconds}s log=${logFile}`,
    );
  }
  return {
    command,
    logFile,
    name,
    status: result.status,
    timedOut: result.timedOut,
  };
}

async function runLanePool(poolLanes, baseEnv, logDir, parallelism, options) {
  const failures = [];
  const pending = [...poolLanes];
  const running = new Set();
  const active = {
    count: 0,
    resources: new Map(),
    weight: 0,
  };
  let lastLaneStartAt = 0;
  let laneStartQueue = Promise.resolve();

  async function waitForLaneStartSlot() {
    if (options.startStaggerMs <= 0) {
      return;
    }
    const previous = laneStartQueue;
    let releaseQueue;
    laneStartQueue = new Promise((resolve) => {
      releaseQueue = resolve;
    });
    await previous;
    const waitMs = Math.max(0, lastLaneStartAt + options.startStaggerMs - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastLaneStartAt = Date.now();
    releaseQueue();
  }

  function canStartLane(candidate) {
    const weight = laneWeight(candidate);
    if (active.count >= parallelism || active.weight + weight > options.weightLimit) {
      return false;
    }
    for (const resource of laneResources(candidate)) {
      const limit = options.resourceLimits[resource] ?? options.weightLimit;
      const current = active.resources.get(resource) ?? 0;
      if (current + weight > limit) {
        return false;
      }
    }
    return true;
  }

  function reserve(candidate) {
    const weight = laneWeight(candidate);
    active.count += 1;
    active.weight += weight;
    for (const resource of laneResources(candidate)) {
      active.resources.set(resource, (active.resources.get(resource) ?? 0) + weight);
    }
  }

  function release(candidate) {
    const weight = laneWeight(candidate);
    active.count -= 1;
    active.weight -= weight;
    for (const resource of laneResources(candidate)) {
      const next = (active.resources.get(resource) ?? 0) - weight;
      if (next > 0) {
        active.resources.set(resource, next);
      } else {
        active.resources.delete(resource);
      }
    }
  }

  async function startLane(poolLane) {
    await waitForLaneStartSlot();
    reserve(poolLane);
    let promise;
    promise = runLane(poolLane, baseEnv, logDir, options.timeoutMs)
      .then((result) => ({ lane: poolLane, promise, result }))
      .finally(() => {
        release(poolLane);
      });
    running.add(promise);
  }

  while (pending.length > 0 || running.size > 0) {
    let started = false;
    if (!options.failFast || failures.length === 0) {
      for (let index = 0; index < pending.length; ) {
        const candidate = pending[index];
        if (!canStartLane(candidate)) {
          index += 1;
          continue;
        }
        pending.splice(index, 1);
        await startLane(candidate);
        started = true;
      }
    }

    if (started) {
      continue;
    }
    if (running.size === 0) {
      const blocked = pending.map(laneSummary).join(", ");
      throw new Error(`No Docker lanes fit scheduler limits: ${blocked}`);
    }

    const { promise, result } = await Promise.race(running);
    running.delete(promise);
    if (result.status !== 0) {
      failures.push(result);
    }
    if (options.failFast && failures.length > 0) {
      const remainingResults = await Promise.all(running);
      running.clear();
      for (const remaining of remainingResults) {
        if (remaining.result.status !== 0) {
          failures.push(remaining.result);
        }
      }
      break;
    }
  }

  return failures;
}

async function tailFile(file, lines) {
  const content = await readFile(file, "utf8").catch(() => "");
  const tail = content.split(/\r?\n/).slice(-lines).join("\n");
  return tail.trimEnd();
}

async function printFailureSummary(failures, tailLines) {
  console.error(`ERROR: ${failures.length} Docker lane(s) failed.`);
  for (const failure of failures) {
    console.error(`---- ${failure.name} failed (status=${failure.status}): ${failure.logFile}`);
    const tail = await tailFile(failure.logFile, tailLines);
    if (tail) {
      console.error(tail);
    }
  }
}

const activeChildren = new Set();
function terminateChild(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to killing the direct child below.
    }
  }
  child.kill(signal);
}

function terminateActiveChildren(signal) {
  for (const child of activeChildren) {
    terminateChild(child, signal);
  }
}

process.on("SIGINT", () => {
  terminateActiveChildren("SIGINT");
  process.exit(130);
});
process.on("SIGTERM", () => {
  terminateActiveChildren("SIGTERM");
  process.exit(143);
});

async function main() {
  const parallelism = parsePositiveInt(
    process.env.OPENCLAW_DOCKER_ALL_PARALLELISM,
    DEFAULT_PARALLELISM,
    "OPENCLAW_DOCKER_ALL_PARALLELISM",
  );
  const tailParallelism = parsePositiveInt(
    process.env.OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM,
    Math.min(parallelism, DEFAULT_TAIL_PARALLELISM),
    "OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM",
  );
  const tailLines = parsePositiveInt(
    process.env.OPENCLAW_DOCKER_ALL_FAILURE_TAIL_LINES,
    DEFAULT_FAILURE_TAIL_LINES,
    "OPENCLAW_DOCKER_ALL_FAILURE_TAIL_LINES",
  );
  const laneTimeoutMs = parsePositiveInt(
    process.env.OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS,
    DEFAULT_LANE_TIMEOUT_MS,
    "OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS",
  );
  const laneStartStaggerMs = parseNonNegativeInt(
    process.env.OPENCLAW_DOCKER_ALL_START_STAGGER_MS,
    DEFAULT_LANE_START_STAGGER_MS,
    "OPENCLAW_DOCKER_ALL_START_STAGGER_MS",
  );
  const failFast = parseBool(process.env.OPENCLAW_DOCKER_ALL_FAIL_FAST, true);
  const runId = process.env.OPENCLAW_DOCKER_ALL_RUN_ID || utcStampForPath();
  const logDir = path.resolve(
    process.env.OPENCLAW_DOCKER_ALL_LOG_DIR ||
      path.join(ROOT_DIR, ".artifacts/docker-tests", runId),
  );
  await mkdir(logDir, { recursive: true });

  const baseEnv = commandEnv({
    OPENCLAW_DOCKER_E2E_IMAGE: process.env.OPENCLAW_DOCKER_E2E_IMAGE || DEFAULT_E2E_IMAGE,
  });
  appendExtension(baseEnv, "matrix");
  appendExtension(baseEnv, "acpx");
  appendExtension(baseEnv, "codex");

  console.log(`==> Docker test logs: ${logDir}`);
  console.log(`==> Parallelism: ${parallelism}`);
  console.log(`==> Tail parallelism: ${tailParallelism}`);
  console.log(`==> Lane timeout: ${laneTimeoutMs}ms`);
  console.log(`==> Lane start stagger: ${laneStartStaggerMs}ms`);
  console.log(`==> Fail fast: ${failFast ? "yes" : "no"}`);
  console.log(`==> Live-test bundled plugin deps: ${baseEnv.OPENCLAW_DOCKER_BUILD_EXTENSIONS}`);
  const schedulerOptions = parseSchedulerOptions(process.env, parallelism);
  const tailSchedulerOptions = parseSchedulerOptions(process.env, tailParallelism);
  console.log(
    `==> Scheduler: weight=${schedulerOptions.weightLimit} docker=${schedulerOptions.resourceLimits.docker} live=${schedulerOptions.resourceLimits.live} npm=${schedulerOptions.resourceLimits.npm} service=${schedulerOptions.resourceLimits.service}`,
  );
  console.log(
    `==> Tail scheduler: weight=${tailSchedulerOptions.weightLimit} docker=${tailSchedulerOptions.resourceLimits.docker} live=${tailSchedulerOptions.resourceLimits.live} npm=${tailSchedulerOptions.resourceLimits.npm} service=${tailSchedulerOptions.resourceLimits.service}`,
  );

  await runForegroundGroup(
    [
      ["Build shared live-test image once", "pnpm test:docker:live-build"],
      [
        `Build shared Docker E2E image once: ${baseEnv.OPENCLAW_DOCKER_E2E_IMAGE}`,
        "pnpm test:docker:e2e-build",
      ],
    ],
    baseEnv,
  );
  await prepareBundledChannelPackage(baseEnv, logDir);

  const options = {
    ...schedulerOptions,
    failFast,
    startStaggerMs: laneStartStaggerMs,
    timeoutMs: laneTimeoutMs,
  };
  const failures = await runLanePool(lanes, baseEnv, logDir, parallelism, options);
  if (failFast && failures.length > 0) {
    await printFailureSummary(failures, tailLines);
    process.exit(1);
  }

  console.log("==> Running provider-sensitive Docker tail lanes");
  failures.push(
    ...(await runLanePool(tailLanes, baseEnv, logDir, tailParallelism, {
      ...options,
      ...tailSchedulerOptions,
    })),
  );
  if (failures.length > 0) {
    await printFailureSummary(failures, tailLines);
    process.exit(1);
  }

  await runForeground(
    "Run cleanup smoke after parallel lanes",
    "pnpm test:docker:cleanup",
    baseEnv,
  );
  console.log("==> Docker test suite passed");
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
