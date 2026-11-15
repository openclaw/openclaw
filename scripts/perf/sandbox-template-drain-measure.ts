/**
 * Real Gateway graceful-drain fixture; synthetic provider, real Git and containers.
 * See the adjacent Markdown for setup and replay. Input repositories are cloned.
 * Validation pauses Git status; refresh pauses a real in-container prepare script.
 * Readiness is the first synthetic provider request for each accepted session,
 * not model quality or final-response latency. Child exit must be code 0, no signal.
 * CPU/allocation are Gateway process counters (exclude Git/container descendants).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { root as openRoot } from "@openclaw/fs-safe/root";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.js";
import { listDirectoryTreeStrict } from "../../src/infra/directory-walk.js";
import { writeGatewayRestartIntentSync } from "../../src/infra/restart-intent.js";
import { closeOpenClawStateDatabaseAsync } from "../../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import {
  connectRestartClient,
  restartModelConfig,
} from "../../test/gateway-restart.test-support.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { BASE_GATEWAY_BENCH_CONFIG } from "../lib/gateway-bench-runtime.js";
import { cleanupDrainFixtureContainers } from "./sandbox-template-drain-cleanup.js";

assert(
  Number.isFinite(getHeapStatistics().total_allocated_bytes),
  "Use Node with exact V8 allocation counter support",
);
const { values } = parseArgs({
  options: {
    candidate: { type: "string", default: process.cwd() },
    entrypoint: { type: "string" },
    "state-fixture": { type: "string" },
    "expected-rebuilds": { type: "string" },
    repo: { type: "string" },
    output: { type: "string" },
    image: { type: "string" },
    backend: { type: "string", default: "docker" },
    case: { type: "string", default: "validation" },
    action: { type: "string", default: "drain" },
    sessions: { type: "string", default: "20" },
    timeout: { type: "string", default: "180000" },
  },
});
assert(values.repo && values.output && values.image, "--repo, --output, --image required");
assert(["validation", "refresh"].includes(values.case));
assert(["control", "drain"].includes(values.action));
const backend = values.backend;
assert(backend === "docker" || backend === "podman");
const expectedRebuilds =
  values["expected-rebuilds"] === undefined ? undefined : Number(values["expected-rebuilds"]);
assert(
  expectedRebuilds === undefined ||
    (Number.isSafeInteger(expectedRebuilds) && expectedRebuilds >= 0),
);
const count = Number(values.sessions),
  timeout = Number(values.timeout);
assert(Number.isSafeInteger(count) && count > 0 && count <= 100);
assert(Number.isSafeInteger(timeout) && timeout > 0);
const output = path.resolve(values.output),
  repo = path.join(output, "repo");
await fs.mkdir(output);
await fs.mkdir(path.join(output, "tmp"));

const shell = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const actualGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
const actualEngine = execFileSync("/usr/bin/which", [backend], { encoding: "utf8" }).trim();
const git = (...args: string[]) =>
  execFileSync(actualGit, ["-C", repo, ...args], { encoding: "utf8" }).trim();
execFileSync(actualGit, ["clone", "--local", "--quiet", path.resolve(values.repo), repo]);
git("config", "user.name", "Synthetic Fixture");
git("config", "user.email", "fixture@example.invalid");
const bin = path.join(output, "bin"),
  arm = path.join(output, "armed"),
  entered = path.join(output, "entered"),
  release = path.join(output, "release");
await fs.mkdir(bin);
await fs.writeFile(
  path.join(bin, "git"),
  `#!/bin/sh\ncase "$*" in\n *'worktree-projections/.templates/'*'status --porcelain=v2'*)\n if test -f ${shell(arm)} && mkdir ${shell(entered)} 2>/dev/null; then\n while ! test -f ${shell(release)}; do sleep 0.05; done\n fi;;\nesac\nexec ${shell(actualGit)} "$@"\n`,
  { mode: 0o755 },
);
const installsFile = path.join(output, "installs.log");
await fs.writeFile(
  path.join(bin, backend),
  `#!/bin/sh\ncase "$*" in *'pnpm install '*) echo install >> ${shell(installsFile)};; esac\nexec ${shell(actualEngine)} "$@"\n`,
  { mode: 0o755 },
);
const metricImport = path.join(output, "metrics.mjs");
await fs.writeFile(
  metricImport,
  `import {appendFileSync} from 'node:fs';import {getHeapStatistics} from 'node:v8';import {isMainThread} from 'node:worker_threads';if(isMainThread)process.on('exit',code=>appendFileSync(${JSON.stringify(path.join(output, "process-metrics.jsonl"))},JSON.stringify({pid:process.pid,code,cpu:process.cpuUsage(),allocatedBytes:getHeapStatistics().total_allocated_bytes,maxRSS:process.resourceUsage().maxRSS})+'\\n'));`,
);
const ready = new Map<string, number>();
const provider = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString();
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
      for (const match of body.matchAll(/DRAIN_FIXTURE_(seed|\d+)/g)) {
        ready.set(match[1]!, ready.get(match[1]!) ?? performance.now());
      }
    }
    writeOpenAiResponsesText(response, {
      text: "fixture complete",
      messageId: `msg_${randomUUID()}`,
      responseId: `resp_${randomUUID()}`,
    });
  })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const address = provider.address();
assert(address && typeof address === "object");
const model = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${address.port}/v1`);
const instance = await createOpenClawTestInstance({
  name: "sandbox-drain",
  cwd: path.resolve(values.candidate),
  entrypoint: [
    "--import",
    metricImport,
    ...(values.entrypoint
      ? [values.entrypoint]
      : ["--import", "./scripts/tsx.mjs", "src/entry.ts"]),
  ],
  gatewayToken: "synthetic-drain-token",
  state: { layout: "split" },
  startTimeoutMs: Math.max(timeout, 180_000),
  stopTimeoutMs: 95000,
  gracefulShutdownTimeoutMs: 95000,
  env: {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    OPENCLAW_SKIP_PROVIDERS: undefined,
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    VITEST: undefined,
    NODE_ENV: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    OPENAI_API_BASE: undefined,
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_PATH_BOOTSTRAPPED: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  },
  config: {
    ...BASE_GATEWAY_BENCH_CONFIG,
    plugins: { enabled: true, allow: ["openai"], slots: { memory: "none" } },
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      auth: { mode: "token", token: "synthetic-drain-token" },
    },
    session: { maintenance: { maxEntries: 10_000, pruneAfter: "365d" } },
    logging: { level: "debug", consoleLevel: "info", file: path.join(output, "gateway.log") },
    ...restartModelConfig(model, repo, {
      maxConcurrent: count,
      sandbox: {
        mode: "all",
        backend,
        scope: "session",
        workspaceAccess: "rw",
        docker: {
          image: values.image,
          user: backend === "docker" ? "0:0" : undefined,
          network: "none",
        },
      },
    }),
  },
});
// Offline synthetic fixtures contain relative session identities; copy only database
// trees plus their matching synthetic client identity; never copy fixture config.
let stateShape: Record<string, unknown> | undefined;
if (values["state-fixture"]) {
  const seed = path.resolve(values["state-fixture"]);
  stateShape = JSON.parse(await fs.readFile(path.join(seed, "team-shape-summary.json"), "utf8"));
  assert(
    stateShape?.format === "openclaw-team-shape-v1",
    "Only generated synthetic state fixtures are supported",
  );
  for (const directory of ["agents", "state", "client"]) {
    const source = path.join(seed, directory);
    const destination = path.join(instance.stateDir, directory);
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    const destinationRoot = await openRoot(destination);
    for (const entry of await listDirectoryTreeStrict(source, { maxEntries: 10_000 })) {
      if (entry.dirent.isDirectory()) {
        await fs.mkdir(path.join(destination, entry.relativePath), {
          recursive: true,
          mode: 0o700,
        });
      } else {
        await destinationRoot.copyIn(entry.relativePath, path.join(source, entry.relativePath), {
          clone: "always",
          overwrite: false,
          mkdir: true,
          durable: false,
          maxBytes: Infinity,
          preserveSourceMode: true,
          preserveMetadata: true,
          sourceSymlinks: "copy-link",
          sourceHardlinks: "allow",
          mutationSymlinks: "reject",
        });
      }
    }
  }
}
const waits = async (predicate: () => boolean | Promise<boolean>, label: string) => {
  const start = performance.now();
  while (!(await predicate())) {
    assert(
      performance.now() - start < timeout,
      `timed out: ${label}\n${instance.logs().slice(-12000)}`,
    );
    await delay(100);
  }
};
const installs = async () =>
  existsSync(installsFile)
    ? (await fs.readFile(installsFile, "utf8")).trim().split("\n").filter(Boolean).length
    : 0;
let client: Awaited<ReturnType<typeof connectRestartClient>> | undefined;
const rows: Record<string, unknown>[] = [];
const save = async () => {
  const lines = (await fs.readFile(path.join(output, "gateway.log"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean);
  const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const builds = events.filter((event) =>
    JSON.stringify(event).includes("sandbox dependency template prepared for the selected commit"),
  );
  const preparations = events.filter((event) =>
    JSON.stringify(event).includes("managed worktree preparation"),
  );
  await fs.writeFile(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        case: values.case,
        action: values.action,
        sessions: count,
        platform: process.platform,
        backend,
        runtime: process.version,
        stateShape,
        builds: builds.length,
        preparations,
        rows,
      },
      null,
      2,
    ),
  );
  await fs.writeFile(path.join(output, "console.log"), instance.logs());
};

function templates() {
  const database = new DatabaseSync(resolveOpenClawStateSqlitePath(instance.env), {
    readOnly: true,
  });
  try {
    // sqlite-allow-raw -- Task-owned synthetic fixture, bounded observation only.
    return database
      .prepare(
        "SELECT id, source_commit, status, path FROM worktree_templates WHERE worktree_root = ? ORDER BY id LIMIT 100",
      )
      .all(path.join(instance.stateDir, "worktree-projections"))
      .map((row) =>
        Object.assign(row, {
          sourceHashes: Object.fromEntries(
            ["package.json", "source.txt"].map((file) => {
              const source = path.join(String(row.path), file);
              return [
                file,
                existsSync(source)
                  ? createHash("sha256").update(readFileSync(source)).digest("hex")
                  : null,
              ];
            }),
          ),
        }),
      );
  } finally {
    database.close();
  }
}
async function boot(phase: string) {
  const started = performance.now();
  await instance.startGateway();
  const readyAt = performance.now();
  rows.push({ phase, load: loadavg(), ms: readyAt - started, pid: instance.child?.pid });
  return readyAt;
}
async function stop(restart: boolean) {
  const child = instance.child;
  assert(child?.pid);
  if (restart) {
    assert(
      writeGatewayRestartIntentSync({
        env: instance.env,
        targetPid: child.pid,
        intent: { reason: "gateway.restart", force: true, waitMs: 100 },
      }),
      "restart intent recorded",
    );
  }
  const started = performance.now(),
    exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code, signal] = await exited;
  rows.push({
    phase: restart ? "graceful-restart" : "seed-stop",
    ms: performance.now() - started,
    code,
    signal,
    pid: child.pid,
  });
  assert.equal(code, 0, "Gateway must exit cleanly");
  assert.equal(signal, null, "Gateway must not be killed");
  await instance.stopGateway();
  await client?.stopAndWait();
  client = undefined;
}
async function create(id: string) {
  assert(client);
  const key = `agent:main:drain-fixture-${id}`;
  await client.request(
    "sessions.create",
    {
      key,
      agentId: "main",
      cwd: repo,
      worktree: true,
      worktreeName: `drain-${id}`,
      worktreeBaseRef: git("rev-parse", "HEAD"),
    },
    { timeoutMs: timeout },
  );
}
async function send(id: string) {
  assert(client);
  const key = `agent:main:drain-fixture-${id}`;
  await client.request("chat.send", {
    sessionKey: key,
    message: `DRAIN_FIXTURE_${id}`,
    idempotencyKey: randomUUID(),
  });
}
try {
  await boot("seed-startup");
  client = await connectRestartClient(instance, { env: instance.env, deviceIdentity: null });
  await create("seed");
  await send("seed");
  await waits(() => ready.has("seed"), "seed sandbox ready");
  rows.push({ phase: "seed", installs: await installs(), templates: templates() });
  if (values.case === "refresh") {
    // The marker is inside node_modules, so idle-template validation ignores it.
    await fs.writeFile(
      path.join(repo, "drain-prepare.cjs"),
      "const fs=require('node:fs');fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/drain-entered','');const end=Date.now()+30000;while(Date.now()<end&&!fs.existsSync('node_modules/drain-release'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);\n",
    );
    const pkg = JSON.parse(await fs.readFile(path.join(repo, "package.json"), "utf8"));
    pkg.scripts = { ...pkg.scripts, prepare: "node drain-prepare.cjs" };
    await fs.writeFile(path.join(repo, "package.json"), JSON.stringify(pkg));
    git("add", "package.json", "drain-prepare.cjs");
    git("commit", "-qm", "synthetic source refresh gate");
  }
  await Promise.all(Array.from({ length: count }, (_, i) => create(String(i))));
  await stop(false);
  if (values.case === "validation") {
    await fs.writeFile(arm, "");
  }
  await boot("target-startup");
  client = await connectRestartClient(instance, { env: instance.env, deviceIdentity: null });
  const cohortStart = performance.now();
  await Promise.all(Array.from({ length: count }, (_, i) => send(String(i))));
  let buildMarker: string | undefined;
  await waits(async () => {
    if (values.case === "validation") {
      return existsSync(entered);
    }
    const templateRoot = path.join(instance.stateDir, "worktree-projections", ".templates");
    const entries = await fs.readdir(templateRoot).catch(() => []);
    for (const entry of entries) {
      const marker = path.join(templateRoot, entry, "node_modules", "drain-entered");
      if (existsSync(marker)) {
        buildMarker = marker;
        break;
      }
    }
    return Boolean(buildMarker);
  }, "actual template command gated");
  const installsAtGate = await installs();
  rows.push({
    phase: "gated",
    templates: templates(),
    installs: await installs(),
    ready: ready.size - 1,
    accepted: count,
    ms: performance.now() - cohortStart,
  });
  assert.equal(ready.size, 1, "cohort must still be preparing when drain begins");
  let readyStart = performance.now();
  let gatewayReadyAt = readyStart;
  if (values.action === "drain") {
    await stop(true);
    rows.push({ phase: "after-drain", templates: templates() });
    await fs.writeFile(release, "");
    readyStart = performance.now();
    gatewayReadyAt = await boot("successor-startup");
    client = await connectRestartClient(instance, { env: instance.env, deviceIdentity: null });
  } else {
    await fs.writeFile(release, "");
    if (buildMarker) {
      await fs.writeFile(path.join(path.dirname(buildMarker), "drain-release"), "");
    }
  }
  await waits(async () => {
    if (values.case === "refresh") {
      const root = path.join(instance.stateDir, "worktree-projections", ".templates");
      for (const name of await fs.readdir(root)) {
        const modules = path.join(root, name, "node_modules");
        if (existsSync(path.join(modules, "drain-entered"))) {
          await fs.writeFile(path.join(modules, "drain-release"), "");
        }
      }
    }
    return Array.from({ length: count }, (_, i) => ready.has(String(i))).every(Boolean);
  }, "all accepted sessions reached provider without resending");
  const elapsed = Array.from(
    { length: count },
    (_, i) => ready.get(String(i))! - readyStart,
  ).toSorted((a, b) => a - b);
  rows.push({
    phase: "cohort-ready",
    templates: templates(),
    installs: await installs(),
    p50Ms: elapsed[Math.ceil(count / 2) - 1],
    maxMs: elapsed.at(-1),
    p50AfterGatewayReadyMs: Math.max(
      0,
      elapsed[Math.ceil(count / 2) - 1]! - (gatewayReadyAt - readyStart),
    ),
    maxAfterGatewayReadyMs: Math.max(0, elapsed.at(-1)! - (gatewayReadyAt - readyStart)),
    ready: count,
  });
  if (expectedRebuilds !== undefined) {
    assert.equal(
      (await installs()) - installsAtGate,
      expectedRebuilds,
      "native installer calls after gate",
    );
  }
  await stop(false);
  await save();
  console.log(JSON.stringify({ output, rows }, null, 2));
} catch (error) {
  rows.push({ phase: "failure", error: String(error) });
  await save();
  throw error;
} finally {
  try {
    await fs.writeFile(release, "");
    await client?.stopAndWait();
    await instance.stopGateway();
    // Preserve state if native cleanup cannot prove resource retirement.
    await cleanupDrainFixtureContainers({
      env: instance.env,
      engine: actualEngine,
      backend,
      output,
    });
    await instance.cleanup();
  } finally {
    try {
      await closeOpenClawStateDatabaseAsync();
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => {
        provider.close(() => resolve());
      });
    }
  }
}
