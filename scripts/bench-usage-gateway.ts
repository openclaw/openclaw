/** Compare real Usage model filters from the repository root; see scripts/README.md. */
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright";
import { acquireGatewayE2ePortBlock } from "../src/gateway/test-helpers.listener.ts";
import { createRedactingStreamWriter } from "../src/logging/redacting-stream.ts";
import { CONTROL_UI_TOKEN_SESSION_KEY_PREFIX } from "../src/shared/control-ui-storage.js";
import {
  mapColdLoadCpuProfile,
  prepareColdLoadTraceEvent,
  summarizeCpuProfile,
} from "./lib/control-ui-cold-load-trace.ts";
import {
  clipInteractionCpuProfile,
  summarizeInteractionTrace,
} from "./lib/control-ui-interaction-trace.ts";
import {
  measureRendererProcessMetrics,
  readControlUiPerformanceMetrics as metrics,
  readRendererProcessSnapshot,
} from "./lib/control-ui-renderer-metrics.ts";
import { stopGatewayGracefully } from "./lib/gateway-bench-child.ts";
import { hashFile, hashInstall } from "./lib/gateway-bench-installed-package.ts";
import {
  measureGatewayCpuUsage,
  readGatewayCpuUsage,
  readGatewayResources,
} from "./lib/gateway-bench-profile.ts";
import {
  buildGatewayBenchChildArgs,
  buildGatewayBenchCommand,
  createGatewayBenchEnv,
  waitForInitialProbe,
} from "./lib/gateway-bench-runtime.ts";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";
import type { UsageBenchFixture } from "./lib/usage-bench-child.ts";
import { startUsageRttProxy } from "./lib/usage-bench-rtt.ts";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string" },
    ui: { type: "string" },
    "head-ui": { type: "string" },
    out: { type: "string" },
    pairs: { type: "string", default: "20" },
    "warm-cpu": { type: "string" },
    "warm-sequence": { type: "boolean", default: false },
    sessions: { type: "string", default: "12000" },
    smoke: { type: "boolean", default: false },
    cold: { type: "boolean", default: false },
    "cold-backend": { type: "boolean", default: false },
    "cold-pairs": { type: "string" },
    diagnostic: { type: "boolean", default: false },
    structure: { type: "boolean", default: false },
    "structure-rtt": { type: "string" },
    "trace-adverse": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: node --import ./scripts/tsx.mjs scripts/bench-usage-gateway.ts --base <checkout> --head <checkout> --ui <frozen-build> --out <new-directory> [--head-ui <frozen-candidate-build>] [--sessions 12000] [--pairs 20] [--warm-cpu 1|4] [--warm-sequence] [--smoke | --cold | --cold-backend [--cold-pairs 20] | --diagnostic | --structure [--structure-rtt 0|100] [--trace-adverse]]",
  );
  process.exit(0);
}
for (const key of ["base", "head", "ui", "out"] as const) {
  assert(values[key], `Missing --${key}`);
}
const base = path.resolve(values.base!);
const head = path.resolve(values.head!);
const ui = path.resolve(values.ui!);
const headUi = values["head-ui"] ? path.resolve(values["head-ui"]) : ui;
const out = path.resolve(values.out!);
const tooling = path.dirname(fileURLToPath(import.meta.url));
const helperFiles = [
  "bench-usage-gateway.ts",
  "lib/usage-bench-child.ts",
  "lib/usage-bench-observer.mjs",
  "lib/usage-bench-rtt.ts",
  "lib/control-ui-renderer-metrics.ts",
  "lib/control-ui-cold-load-trace.ts",
  "lib/control-ui-interaction-trace.ts",
];
const helperHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      helperFiles.map(async (file) => [file, await hashFile(path.join(tooling, file))]),
    ),
  );
const pairs = Number(values.pairs);
const population = Number(values.sessions);
const warmSetup =
  !values.cold && !values["cold-backend"] && !values.diagnostic && !values.structure;
const MANAGED_CHILD_TIMEOUT_MS = 30 * 60_000;
const structureRtt = values["structure-rtt"] === undefined ? 0 : Number(values["structure-rtt"]);
if (values["structure-rtt"] !== undefined) {
  assert(values.structure, "--structure-rtt requires --structure");
  assert(
    values["structure-rtt"] === "0" || values["structure-rtt"] === "100",
    "--structure-rtt must be 0 or 100",
  );
}
assert(!values["trace-adverse"] || values.structure, "--trace-adverse requires --structure");
const warmCpu = values["warm-cpu"] === undefined ? undefined : Number(values["warm-cpu"]);
if (warmCpu !== undefined) {
  assert(values["warm-cpu"] === "1" || values["warm-cpu"] === "4", "--warm-cpu must be 1 or 4");
  assert(
    ![values.smoke, values.cold, values["cold-backend"], values.diagnostic, values.structure].some(
      Boolean,
    ),
    "--warm-cpu only selects ordinary warm filter runs",
  );
}
if (values["warm-sequence"]) {
  assert(warmCpu === undefined || warmCpu === 1, "--warm-sequence uses native CPU only");
  assert(
    ![values.smoke, values.cold, values["cold-backend"], values.diagnostic, values.structure].some(
      Boolean,
    ),
    "--warm-sequence requires untraced ordinary warm filters",
  );
}
const coldPairs = values["cold-pairs"] === undefined ? undefined : Number(values["cold-pairs"]);
if (coldPairs !== undefined) {
  assert(values["cold-backend"], "--cold-pairs requires --cold-backend");
  assert(Number.isInteger(coldPairs) && coldPairs > 0, "--cold-pairs must be positive");
}
assert(Number.isInteger(pairs) && pairs > 0);
assert(Number.isInteger(population) && population > 0);
assert(
  [values.smoke, values.cold, values["cold-backend"], values.diagnostic, values.structure].filter(
    Boolean,
  ).length <= 1,
  "Choose at most one of --smoke, --cold, --cold-backend, --diagnostic and --structure",
);
await mkdir(out, { recursive: false });

type Ready = UsageBenchFixture & { port: number; token: string };
type Dispatch = { kind: string; rows: number; contextRows: number; packedBytes: number };
type Snapshot = { channel: "usage-volume-fixture"; action: "snapshot"; dispatches: Dispatch[] };
type Owner = {
  role: keyof typeof roleUiBuilds;
  child: ChildProcess;
  deadlineAtMs: number;
  ready: Ready;
  snapshot: () => Promise<Dispatch[]>;
  close: () => Promise<void>;
};
type PageEntry = {
  owner: Owner;
  browser: Browser;
  processSession: CDPSession;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  proxy: Awaited<ReturnType<typeof startUsageRttProxy>> | undefined;
  usage: ReturnType<typeof observeUsage>;
  wire?: ReturnType<typeof observeWire>;
  finishDiagnostic?: () => Promise<void>;
  finishStructure?: () => Promise<unknown>;
};
const owners: Owner[] = [];
type ColdFixture = {
  fixture: UsageBenchFixture;
  token: string;
  claim: Awaited<ReturnType<typeof acquireGatewayE2ePortBlock>>;
  pristine: string;
  identity: Awaited<ReturnType<typeof hashInstall>>;
  available: boolean;
};
const coldFixtures = new Map<string, ColdFixture>();
const fixtureTokens: string[] = [];
const samples: Array<
  Record<string, unknown> & { browserResources?: ReturnType<typeof browserResources> }
> = [];
const sequences: Array<Record<string, unknown>> = [];
const preparations: Array<Record<string, unknown>> = [];
let activeStep: Record<string, string | number> = { phase: "startup" };
const browsers = new Set<Browser>();
const failures: string[] = [];
const errorText = (error: unknown) =>
  fixtureTokens.reduce(
    (message, token) => message.replaceAll(token, "[fixture token]"),
    String(error),
  );
// Freeze both complete runtime outputs before any source seeding or Gateway starts.
const buildRoots = new Map<string, Awaited<ReturnType<typeof inspectBuild>>>();
for (const root of new Set([base, head])) {
  buildRoots.set(root, await inspectBuild(root));
}
await writeFile(
  path.join(out, "build-roots.json"),
  JSON.stringify([...buildRoots.values()], null, 2),
);
const helperSources = await helperHashes();
const uiBuild = { root: ui, ...(await hashInstall(ui)) };
const headUiBuild = headUi === ui ? uiBuild : { root: headUi, ...(await hashInstall(headUi)) };
const roleUiBuilds = { "base-a": uiBuild, head: headUiBuild, "base-b": uiBuild };
await writeFile(
  path.join(out, "helper-sources.json"),
  JSON.stringify(
    { root: tooling, files: helperSources, ui: uiBuild, uiByRole: roleUiBuilds },
    null,
    2,
  ),
);

async function inspectBuild(root: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const source = git("rev-parse", "HEAD");
  assert.equal(
    git("status", "--porcelain", "--untracked-files=no"),
    "",
    `${root}: tracked source is dirty`,
  );
  const dist = path.join(root, "dist");
  const buildInfo = JSON.parse(await readFile(path.join(dist, "build-info.json"), "utf8"));
  assert.equal(buildInfo.commit, source, `${root}: build-info commit differs from source`);
  for (const name of [".buildstamp", ".runtime-postbuildstamp"]) {
    const stamp = JSON.parse(await readFile(path.join(dist, name), "utf8"));
    assert.equal(stamp.head, source, `${root}: ${name} head differs from source`);
    assert.equal(stamp.inputsClean, true, `${root}: ${name} was built from dirty inputs`);
  }
  const entry = path.join(dist, "entry.js");
  const workers = [
    "infra/session-cost-usage-overview-report.worker.js",
    "state/openclaw-state-read.worker.js",
  ];
  const files = Object.fromEntries(
    await Promise.all(
      ["entry.js", ...workers].map(async (file) => [file, await hashFile(path.join(dist, file))]),
    ),
  );
  const preloads = Object.fromEntries(
    await Promise.all(
      [
        "scripts/lib/gateway-bench-profile-preload.ts",
        "scripts/lib/gateway-bench-stop-preload.mjs",
      ].map(async (file) => [file, await hashFile(path.join(root, file))]),
    ),
  );
  return { root, source, entry, buildInfo, files, preloads, dist: await hashInstall(dist) };
}

async function start(root: string, role: Owner["role"], coldPair?: number): Promise<Owner> {
  const retained = coldFixtures.get(role);
  if (retained) {
    assert(retained.available, `${role} previous Gateway must drain before restoration`);
    retained.available = false;
  }
  const directory = path.join(out, coldPair === undefined ? role : `${role}-${coldPair + 1}`);
  await mkdir(directory);
  const setup = path.join(directory, "setup.json");
  const token = retained?.token ?? randomUUID();
  fixtureTokens.push(token);
  const log = openSync(path.join(directory, "gateway.log"), "wx");
  const output = [0, 1].map(() =>
    createRedactingStreamWriter(
      {
        write(text) {
          writeSync(log, text);
          return true;
        },
      },
      [token],
    ),
  );
  const closeLog = () => {
    try {
      for (const writer of output) {
        writer.flush();
      }
    } finally {
      closeSync(log);
    }
  };
  const abort = new AbortController();
  let claim: Awaited<ReturnType<typeof acquireGatewayE2ePortBlock>> | undefined = retained?.claim;
  let fixture: UsageBenchFixture | undefined = retained?.fixture;
  let run: Promise<number> | undefined;
  const cleanup = async () => {
    abort.abort();
    let joined = run === undefined;
    try {
      if (run) {
        await run;
      }
      joined = true;
    } catch (error) {
      joined = !hasUnjoinedWork(error);
      if (!joined) {
        throw error;
      }
    } finally {
      // Cancellation can reject after a successful join; only uncertain trees retain ownership.
      if (joined) {
        try {
          closeLog();
          const coldFixture = coldFixtures.get(role);
          if (coldFixture) {
            coldFixture.available = true;
          } else if (fixture) {
            await rm(fixture.root, { recursive: true, force: true });
          }
        } finally {
          if (!coldFixtures.has(role)) {
            await claim?.release();
          }
        }
      }
    }
  };
  try {
    let seedMs = 0;
    if (retained) {
      // This root is only the owned synthetic fixture. Absolute config paths stay unchanged.
      await rm(retained.fixture.root, { recursive: true, force: true });
      await cp(retained.pristine, retained.fixture.root, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
        mode: constants.COPYFILE_FICLONE,
      });
      assert.deepEqual(await hashInstall(retained.fixture.root), retained.identity);
    } else {
      claim = await acquireGatewayE2ePortBlock();
      await writeFile(
        setup,
        JSON.stringify({ uiRoot: roleUiBuilds[role].root, sessions: population, port: claim.port }),
      );
      const seeded = Promise.withResolvers<UsageBenchFixture>();
      const seedStarted = performance.now();
      run = runManagedCommand({
        bin: process.execPath,
        cwd: path.dirname(tooling),
        args: [
          "--import",
          path.join(tooling, "tsx.mjs"),
          path.join(tooling, "lib/usage-bench-child.ts"),
          setup,
        ],
        env: {
          ...createGatewayBenchEnv(directory, "", { startupTrace: false }),
          TMPDIR: directory,
          NODE_DISABLE_COMPILE_CACHE: "1",
          OPENCLAW_USAGE_BENCH_TOKEN: token,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        timeoutMs: MANAGED_CHILD_TIMEOUT_MS,
        signal: abort.signal,
        requireProcessTreeExit: true,
        onReady(child) {
          child.stdout!.on("data", output[0]!.write);
          child.stderr!.on("data", output[1]!.write);
          child.on("message", (message) => {
            if (
              typeof message === "object" &&
              message !== null &&
              "channel" in message &&
              message.channel === "usage-volume-fixture" &&
              "action" in message &&
              message.action === "seeded"
            ) {
              seeded.resolve(message as UsageBenchFixture);
            }
          });
        },
      });
      void run.then(
        (code) => seeded.reject(new Error(`${role} seed exited before handoff: ${code}`)),
        seeded.reject,
      );
      fixture = await seeded.promise;
      assert.equal(await run, 0, `${role} seed process and writers joined`);
      seedMs = performance.now() - seedStarted;
      if (coldPair !== undefined) {
        const pristine = path.join(out, `${role}-pristine`);
        const identity = await hashInstall(fixture.root);
        coldFixtures.set(role, { fixture, token, claim, pristine, identity, available: false });
        // Seed writers have joined; no compiled Gateway has opened these files yet.
        await cp(fixture.root, pristine, {
          recursive: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
          errorOnExist: true,
          force: false,
          mode: constants.COPYFILE_FICLONE,
        });
        assert.deepEqual(await hashInstall(pristine), identity);
        await writeFile(
          path.join(out, `${role}-pristine.json`),
          JSON.stringify(
            {
              root: fixture.root,
              pristine,
              identity,
              seedMs,
            },
            null,
            2,
          ),
        );
      }
    }
    assert(fixture && claim);
    await writeFile(path.join(directory, "fixture.json"), JSON.stringify(fixture, null, 2));
    const entry = buildRoots.get(root)!.entry;
    const stopPreload = pathToFileURL(
      path.join(root, "scripts/lib/gateway-bench-stop-preload.mjs"),
    );
    stopPreload.searchParams.set("parentPid", String(process.pid));
    stopPreload.searchParams.set("entry", entry);
    const command = buildGatewayBenchCommand(
      buildGatewayBenchChildArgs(
        entry,
        claim.port,
        [
          "--expose-gc",
          "--import",
          path.join(root, "scripts/lib/gateway-bench-profile-preload.ts"),
          "--import",
          path.join(tooling, "lib/usage-bench-observer.mjs"),
          "--import",
          stopPreload.href,
        ],
        "token",
      ),
      { gatewayRuntime: process.execPath },
    );
    const started = Promise.withResolvers<ChildProcess>();
    const startAt = performance.now();
    run = runManagedCommand({
      bin: command.command,
      args: command.args,
      cwd: root,
      env: createGatewayBenchEnv(fixture.home, fixture.configPath, {
        startupTrace: false,
        caseEnv: {
          OPENCLAW_STATE_DIR: fixture.stateDir,
          TMPDIR: directory,
          NODE_DISABLE_COMPILE_CACHE: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
        },
      }),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      timeoutMs: MANAGED_CHILD_TIMEOUT_MS,
      signal: abort.signal,
      requireProcessTreeExit: true,
      onReady(child) {
        child.stdout!.on("data", output[0]!.write);
        child.stderr!.on("data", output[1]!.write);
        started.resolve(child);
      },
    });
    void run.then(
      (code) => started.reject(new Error(`${role} Gateway exited before start: ${code}`)),
      started.reject,
    );
    const child = await started.promise;
    const readiness = await waitForInitialProbe({
      deadlineAt: startAt + 120_000,
      startAt,
      path: "/readyz",
      port: claim.port,
      isDone: () => child.exitCode !== null || child.signalCode !== null,
    });
    const readyAtMs = performance.now();
    assert.equal(readiness.status, 200, `${role} built Gateway readiness`);
    await writeFile(
      path.join(directory, "startup.json"),
      JSON.stringify(
        {
          seedMs,
          startedAtMs: startAt,
          readyAtMs,
          readiness,
          source: buildRoots.get(root)!.source,
          pid: child.pid,
        },
        null,
        2,
      ),
    );
    const snapshot = () =>
      new Promise<Dispatch[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.off("message", onMessage);
          reject(new Error("Fixture snapshot timed out"));
        }, 30_000);
        const onMessage = (message: unknown) => {
          if (
            typeof message !== "object" ||
            message === null ||
            !("channel" in message) ||
            message.channel !== "usage-volume-fixture" ||
            !("action" in message) ||
            message.action !== "snapshot"
          ) {
            return;
          }
          clearTimeout(timer);
          child.off("message", onMessage);
          resolve((message as Snapshot).dispatches);
        };
        child.on("message", onMessage);
        child.send({ channel: "usage-volume-fixture", action: "snapshot" });
      });
    return {
      role,
      child,
      deadlineAtMs: startAt + MANAGED_CHILD_TIMEOUT_MS,
      ready: { ...fixture, port: claim.port, token },
      snapshot,
      async close() {
        try {
          await stopGatewayGracefully(child, 30_000);
          assert.equal(await run, 0, `${role} clean shutdown`);
        } finally {
          await cleanup();
        }
        await writeFile(
          path.join(directory, "close.json"),
          JSON.stringify({ closedAtMs: performance.now() }),
        );
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function expectedRange(fixture: Ready, startDate: string, endDate: string) {
  assert.match(startDate, /^\d{4}-\d{2}-\d{2}$/u);
  assert.match(endDate, /^\d{4}-\d{2}-\d{2}$/u);
  const firstDay = Date.parse(fixture.startDate);
  let tokens = 0;
  for (let index = 0; index < fixture.sessions; index++) {
    const day = new Date(firstDay + (index % 180) * 86_400_000).toISOString().slice(0, 10);
    if (day < startDate || day > endDate) {
      continue;
    }
    tokens += (100 + index) * (index % 16 === 0 ? 2 : 1);
  }
  // Fresh transcript mtimes retain the whole roster; date bounds limit usage totals.
  return { sessions: fixture.sessions, tokens };
}

function observeUsage(page: Page) {
  const pending = new Map<
    string,
    {
      query: string;
      startDate: string;
      endDate: string;
      started: number;
    }
  >();
  const responses: Array<{
    requestId: string;
    receivedAtMs: number;
    query: string;
    startDate: string;
    endDate: string;
    tokens: number;
    sessions: number;
    bytes: number;
    ms: number;
    ok: boolean;
    partial: boolean;
    payload?: unknown;
  }> = [];
  const errors: Array<{ kind: string; message: string }> = [];
  page.on("pageerror", (error) => errors.push({ kind: "pageerror", message: errorText(error) }));
  page.on("requestfailed", (request) =>
    errors.push({
      kind: "requestfailed",
      message: `${request.method()} ${new URL(request.url()).pathname}: ${errorText(request.failure()?.errorText)}`,
    }),
  );
  page.on("websocket", (socket) => {
    socket.on("socketerror", (error) =>
      errors.push({ kind: "socketerror", message: errorText(error) }),
    );
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type === "req" && frame.method === "sessions.usage") {
        pending.set(frame.id, {
          query: frame.params.query ?? "",
          startDate: frame.params.startDate,
          endDate: frame.params.endDate,
          started: performance.now(),
        });
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      const request = pending.get(frame.id);
      if (!request) {
        return;
      }
      pending.delete(frame.id);
      responses.push({
        requestId: frame.id,
        receivedAtMs: performance.now(),
        query: request.query,
        startDate: request.startDate,
        endDate: request.endDate,
        tokens: frame.payload?.totals?.totalTokens,
        sessions: frame.payload?.overview?.total,
        bytes: Buffer.byteLength(String(payload)),
        ms: performance.now() - request.started,
        ok: frame.ok === true,
        partial: frame.payload?.partial !== undefined,
        ...(values.diagnostic && request.query === "model:fixture-model-00-end"
          ? { payload: frame.payload }
          : {}),
      });
    });
  });
  return { responses, pending, errors };
}

/** Protocol metadata only: never retain frame bodies, labels, or user content. */
function observeWire(page: Page) {
  const frames: Array<{
    socket: number;
    direction: "sent" | "received";
    atMs: number;
    bytes: number;
    type?: string;
    id?: string;
    method?: string;
    event?: string;
    seq?: number;
    ok?: boolean;
  }> = [];
  let sockets = 0;
  page.on("websocket", (socket) => {
    const index = sockets++;
    const record = (direction: "sent" | "received", payload: string | Buffer) => {
      const frame = JSON.parse(String(payload));
      frames.push({
        socket: index,
        direction,
        atMs: performance.now(),
        bytes: Buffer.byteLength(payload),
        type: frame.type,
        id: frame.id,
        method: frame.method,
        event: frame.event,
        seq: frame.seq,
        ok: frame.ok,
      });
    };
    socket.on("framesent", ({ payload }) => record("sent", payload));
    socket.on("framereceived", ({ payload }) => record("received", payload));
  });
  return frames;
}

/** Counts mutation records and node identity; it does not copy DOM content. */
async function startUsageStructure(entry: PageEntry) {
  const handle = await entry.page.evaluateHandle(() => {
    const root = document.querySelector("openclaw-usage-page");
    if (!root) {
      throw new Error("Usage host missing before structural trace");
    }
    const ids = new WeakMap<Node, number>();
    let nextId = 0;
    const identity = (node: Node) => {
      let id = ids.get(node);
      if (id === undefined) {
        id = nextId++;
        ids.set(node, id);
      }
      return id;
    };
    const snapshot = () => ({
      host: identity(root),
      page: Array.from(root.querySelectorAll(".usage-page"), identity),
      charts: Array.from(
        root.querySelectorAll(".daily-chart-bars, .usage-heatmap__svg, .timeseries-svg"),
        identity,
      ),
      rows: Array.from(root.querySelectorAll(".session-bar-row"), identity),
    });
    const mutations = {
      batches: 0,
      childList: 0,
      addedRoots: 0,
      removedRoots: 0,
      attributes: 0,
      characterData: 0,
    };
    const consume = (records: MutationRecord[]) => {
      if (records.length) {
        mutations.batches++;
      }
      for (const record of records) {
        if (record.type === "childList") {
          mutations.childList++;
          mutations.addedRoots += record.addedNodes.length;
          mutations.removedRoots += record.removedNodes.length;
        } else if (record.type === "attributes") {
          mutations.attributes++;
        } else {
          mutations.characterData++;
        }
      }
    };
    const before = snapshot();
    const observer = new MutationObserver(consume);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const startedMs = performance.now();
    return {
      finish() {
        consume(observer.takeRecords());
        observer.disconnect();
        return {
          startedMs,
          finishedMs: performance.now(),
          before,
          after: snapshot(),
          sameHost: root === document.querySelector("openclaw-usage-page"),
          hostConnected: root.isConnected,
          mutations,
        };
      },
    };
  });
  entry.finishStructure = async () => {
    entry.finishStructure = undefined;
    try {
      return await handle.evaluate((probe) => probe.finish());
    } finally {
      await handle.dispose();
    }
  };
}

/** Attribution-only retained counters; forced GC never belongs to a timed action. */
async function browserRetention(cdp: CDPSession) {
  await cdp.send("HeapProfiler.collectGarbage");
  const snapshot = await metrics(cdp);
  const dom = await cdp.send("Memory.getDOMCounters");
  return {
    atMs: performance.now(),
    heapUsedBytes: snapshot.JSHeapUsedSize,
    heapTotalBytes: snapshot.JSHeapTotalSize,
    dom,
  };
}

async function waitForResponse(
  responses: ReturnType<typeof observeUsage>["responses"],
  after: number,
  query: string,
  expectedSessions?: number,
) {
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    const response = responses
      .slice(after)
      .find(
        (row) =>
          row.query === query &&
          !row.partial &&
          (expectedSessions === undefined || row.sessions === expectedSessions),
      );
    if (response) {
      assert.equal(response.ok, true, "actual sessions.usage response");
      assert.equal(response.partial, false, "complete actual usage response");
      return response;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`No actual Usage response for ${query}`);
}
async function settled(page: Page, count: number, diagnostic = false) {
  await page.waitForFunction((expected) => {
    const button = document.querySelector<HTMLButtonElement>(
      '.usage-page button[aria-label="Refresh"]',
    );
    const text = document
      .querySelector(".usage-query-count")
      ?.textContent?.replaceAll(",", "")
      .replaceAll(".", "");
    return button?.disabled === false && text?.startsWith(`${expected} `);
  }, count);
  if (diagnostic) {
    await page.evaluate(() => performance.mark("usage:visible"));
  }
  await page.evaluate(
    (tracing) =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          if (tracing) {
            performance.mark("usage:raf1");
          }
          requestAnimationFrame(() => {
            if (tracing) {
              performance.mark("usage:raf2");
            }
            resolve();
          });
        });
      }),
    diagnostic,
  );
}
async function rendererProbe(cdp: CDPSession) {
  const startedMs = performance.now();
  const processes = await readRendererProcessSnapshot(cdp);
  return { startedMs, finishedMs: performance.now(), processes };
}
function browserResources(
  before: Awaited<ReturnType<typeof rendererProbe>>,
  after: Awaited<ReturnType<typeof rendererProbe>>,
  metricsBefore: Awaited<ReturnType<typeof metrics>>,
  metricsAfter: Awaited<ReturnType<typeof metrics>>,
) {
  assert(Number.isFinite(metricsBefore.JSHeapUsedSize), "Valid initial browser heap");
  assert(Number.isFinite(metricsAfter.JSHeapUsedSize), "Valid final browser heap");
  return {
    complete: true,
    ...measureRendererProcessMetrics(before.processes, after.processes),
    heapBeforeBytes: metricsBefore.JSHeapUsedSize,
    heapAfterBytes: metricsAfter.JSHeapUsedSize,
    heapDeltaBytes: metricsAfter.JSHeapUsedSize - metricsBefore.JSHeapUsedSize,
    probes: { before, after },
    hostMemory: { freeBytes: os.freemem(), totalBytes: os.totalmem() },
  };
}

function measureBrowserCpu(
  before: Awaited<ReturnType<typeof metrics>>,
  after: Awaited<ReturnType<typeof metrics>>,
) {
  return Object.fromEntries(
    ["ThreadTime", "TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map(
      (key) => {
        const beforeValue = before[key];
        const afterValue = after[key];
        assert(
          typeof beforeValue === "number" && Number.isFinite(beforeValue),
          `Invalid initial ${key}`,
        );
        assert(
          typeof afterValue === "number" && Number.isFinite(afterValue),
          `Invalid final ${key}`,
        );
        const ms = (afterValue - beforeValue) * 1000;
        assert(Number.isFinite(ms) && ms >= 0, `Invalid ${key} delta`);
        return [key, ms] as const;
      },
    ),
  );
}

/** Attribution only: keep raw events and the wider process-probe interval. */
async function startUsageDiagnostic(entry: PageEntry, prefix: string) {
  const { cdp, page } = entry;
  const events: unknown[] = [];
  const collect = ({ value }: { value: unknown[] }) => events.push(...value);
  cdp.on("Tracing.dataCollected", collect);
  await cdp.send("Tracing.start", {
    categories: "toplevel,blink.user_timing,devtools.timeline,cc,disabled-by-default-v8.gc",
    transferMode: "ReportEvents",
  });
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  await cdp.send("Profiler.start");
  entry.finishDiagnostic = async () => {
    // Retire before awaits: cleanup must not stop this same capture twice.
    entry.finishDiagnostic = undefined;
    let profile: Awaited<ReturnType<typeof cdp.send<"Profiler.stop">>>["profile"];
    try {
      profile = (await cdp.send("Profiler.stop")).profile;
    } finally {
      const complete = new Promise<void>((resolve) => {
        cdp.once("Tracing.tracingComplete", () => resolve());
      });
      await cdp.send("Tracing.end");
      await complete;
      cdp.off("Tracing.dataCollected", collect);
      await writeFile(
        path.join(out, `${prefix}.trace.json`),
        JSON.stringify({ traceEvents: events }),
      );
    }
    await writeFile(path.join(out, `${prefix}.cpuprofile`), JSON.stringify(profile));
    const action = summarizeInteractionTrace(events, {
      start: "usage:action-start",
      end: "usage:action-end",
    });
    const probes = summarizeInteractionTrace(events, {
      start: "usage:probe-start",
      end: "usage:probe-end",
    });
    const prepared = events.map(prepareColdLoadTraceEvent);
    const threadNames = new Map(
      prepared
        .filter((event) => event.pid === probes.rendererPid && event.name === "thread_name")
        .map((event) => [event.tid, event.args?.name]),
    );
    await writeFile(
      path.join(out, `${prefix}.renderer-events.json`),
      JSON.stringify(
        prepared
          .filter(
            (event) =>
              event.pid === probes.rendererPid &&
              event.ts >= probes.startUs &&
              event.ts <= probes.endUs,
          )
          .map((event) => Object.assign(event, { threadName: threadNames.get(event.tid) })),
        null,
        2,
      ),
    );
    const clipped = clipInteractionCpuProfile(profile, action.startUs, action.endUs);
    const mapped = await mapColdLoadCpuProfile(clipped, {
      assetBaseUrl: new URL("assets/", page.url()).href,
      assetDirectory: path.join(roleUiBuilds[entry.owner.role].root, "assets"),
    });
    await writeFile(
      path.join(out, `${prefix}.attribution.json`),
      JSON.stringify(
        {
          diagnosticOnly: true,
          action,
          probes,
          mappedFrames: mapped.mappedFrames,
          unmappedFrames: mapped.unmappedFrames,
          ...summarizeCpuProfile(mapped.profile, { includeTables: true }),
          limitation:
            "Raw trace retains other renderer threads; main-thread summaries are not whole-renderer CPU. Traced timing is not acceptance evidence.",
        },
        null,
        2,
      ),
    );
  };
  await page.evaluate(() => performance.mark("usage:probe-start"));
}
const usageBackendImports =
  values["cold-backend"] || warmSetup
    ? await Promise.all([
        import("../src/gateway/client.ts"),
        import("../src/infra/device-identity-material.ts"),
        import("../ui/src/lib/sessions/usage.ts"),
        import("../ui/src/pages/usage/helpers.ts"),
      ])
    : undefined;

async function prepareUsageBackend(owner: Owner, mode: "cold" | "warm", coldPair?: number) {
  assert(usageBackendImports);
  const [
    { GatewayClient },
    { generateStoredDeviceIdentity },
    { requestSessionUsage },
    { DEFAULT_USAGE_SESSION_SORT },
  ] = usageBackendImports;
  const url = `ws://127.0.0.1:${owner.ready.port}`;
  const connected = Promise.withResolvers<void>();
  const connectionTimer = setTimeout(
    () => connected.reject(new Error(`${owner.role} ${mode} client connection timed out`)),
    30_000,
  );
  const publications: Array<{
    observedAtMs: number;
    usageUpdatedAt: number;
    usageRefreshFailed: boolean;
  }> = [];
  let latestPublication = 0;
  let committedAt = 0;
  let wakePublication: (() => void) | undefined;
  const peer = new GatewayClient({
    url,
    origin: `http://127.0.0.1:${owner.ready.port}`,
    token: owner.ready.token,
    clientName: "openclaw-control-ui",
    mode: "webchat",
    platform: "MacIntel",
    // Match Control UI scopes; the ephemeral device never uses saved credentials.
    scopes: [
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.questions",
      "operator.pairing",
    ],
    deviceIdentity: generateStoredDeviceIdentity(),
    deviceAuthScope: gatewayOriginScope(url),
    sharedStateMode: "read-only",
    requestTimeoutMs: 60_000,
    onHelloOk: () => connected.resolve(),
    onConnectError: connected.reject,
    onEvent: (event) => {
      const publication = event.payload;
      if (
        event.event !== "chat.metadata.changed" ||
        typeof publication !== "object" ||
        publication === null ||
        !("agentId" in publication) ||
        publication.agentId !== "main" ||
        !("usageUpdatedAt" in publication) ||
        typeof publication.usageUpdatedAt !== "number" ||
        publication.usageUpdatedAt <= latestPublication
      ) {
        return;
      }
      latestPublication = publication.usageUpdatedAt;
      const failed = "usageRefreshFailed" in publication && publication.usageRefreshFailed === true;
      publications.push({
        observedAtMs: performance.now(),
        usageUpdatedAt: latestPublication,
        usageRefreshFailed: failed,
      });
      // Match gateway-store: failed receipts never advance the last successful commit.
      if (!failed) {
        committedAt = latestPublication;
        wakePublication?.();
      }
    },
  });
  const suffix = `${owner.role}${coldPair === undefined ? "" : `-${coldPair}`}`;
  const responseFile = `${suffix}-${mode}-backend-responses.json`;
  const requests: Array<{ method: string; params: unknown }> = [];
  const responses: Array<Record<string, unknown>> = [];
  const sample: Record<string, unknown> = {
    role: owner.role,
    phase: mode === "cold" ? "cold-complete-ready" : "warm-preparation",
    ...(coldPair === undefined ? {} : { coldPair }),
    cpu: 1,
    rtt: 0,
    requests,
    responses,
    publications,
    responseFile,
    ...(mode === "warm" ? { deadlineAtMs: owner.deadlineAtMs } : {}),
  };
  activeStep = { role: owner.role, phase: String(sample.phase) };
  if (mode === "warm") {
    preparations.push(sample);
  }
  try {
    peer.start();
    await connected.promise;
    clearTimeout(connectionTimer);
    assert.deepEqual(await owner.snapshot(), [], "No report aggregation before the first RPC");
    const query = {
      startDate: owner.ready.startDate,
      endDate: owner.ready.endDate,
      scope: "family" as const,
      timeZone: "local" as const,
      ...DEFAULT_USAGE_SESSION_SORT,
    };
    sample.query = query;
    const before = await readGatewayCpuUsage(owner.child, { includeWorkers: true });
    const started = performance.now();
    // Cold proof keeps its original budget. Warm preparation ends within the
    // compiled Gateway's existing managed lifetime, outside measured actions.
    const signal = AbortSignal.timeout(
      mode === "cold" ? 60_000 : Math.max(0, Math.floor(owner.deadlineAtMs - performance.now())),
    );
    if (mode === "cold") {
      samples.push(sample);
    }
    let usedCommit = committedAt;
    let requestBefore = before;
    let dispatchStart = 0;
    for (;;) {
      signal.throwIfAborted();
      const requestStarted = performance.now();
      const attempt: Record<string, unknown> = { startedMs: requestStarted };
      responses.push(attempt);
      const result = await requestSessionUsage(
        {
          request<T>(
            method: string,
            params: unknown,
            options?: Parameters<typeof peer.request>[2],
          ) {
            requests.push({ method, params });
            return peer.request<T>(method, params, options);
          },
        },
        query,
        { projection: "overview", signal },
      ).then(
        (response) => ({ ok: true as const, response }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const finished = performance.now();
      Object.assign(attempt, {
        ...(result.ok ? { response: result.response } : { error: errorText(result.error) }),
        wallMs: finished - requestStarted,
        actionInterval: { startedMs: requestStarted, finishedMs: finished },
      });
      const after = await readGatewayCpuUsage(owner.child, { includeWorkers: true });
      const dispatches = await owner.snapshot();
      Object.assign(attempt, {
        gatewayCpu: measureGatewayCpuUsage(requestBefore, after),
        gatewayCpuSnapshots: { before: requestBefore, after },
        dispatches: dispatches.slice(dispatchStart),
      });
      // Preserve partial payloads and measurements before any correctness assertion.
      await writeFile(
        path.join(out, responseFile),
        JSON.stringify({ requests, responses, publications }, null, 2),
      );
      if (!result.ok) {
        throw result.error;
      }
      const response = result.response;
      if (responses.length === 1) {
        sample.firstResponseWallMs = finished - started;
        sample.firstResponseGatewayCpu = measureGatewayCpuUsage(before, after);
      }
      if (!response.partial) {
        Object.assign(sample, {
          wallMs: finished - started,
          actionInterval: { startedMs: started, finishedMs: finished },
          gatewayCpu: measureGatewayCpuUsage(before, after),
          gatewayCpuSnapshots: { before, after },
          dispatches,
          response,
          load: os.loadavg(),
        });
        assert.equal(response.overview?.total, population);
        assert.equal(response.totals.totalTokens, owner.ready.allTokens);
        assert.equal(response.sessions.length, Math.min(population, 50));
        assert(dispatches.length > 0, "Usage request aggregated the snapshot");
        if (mode === "cold") {
          const resourcesFile = `${suffix}-cold-backend-resources.json`;
          sample.resourcesFile = resourcesFile;
          await writeFile(
            path.join(out, resourcesFile),
            JSON.stringify(
              await readGatewayResources(owner.child, {
                includeWorkers: true,
                collectGarbage: true,
              }),
              null,
              2,
            ),
          );
        }
        return;
      }
      // A successful publication during the read stays pending; no timed session polling.
      if (committedAt <= usedCommit) {
        const published = Promise.withResolvers<void>();
        const abort = () => published.reject(signal.reason);
        wakePublication = published.resolve;
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          await published.promise;
        } finally {
          signal.removeEventListener("abort", abort);
          wakePublication = undefined;
        }
      }
      usedCommit = committedAt;
      requestBefore = await readGatewayCpuUsage(owner.child, { includeWorkers: true });
      dispatchStart = dispatches.length;
    }
  } catch (error) {
    sample.error = errorText(error);
    throw error;
  } finally {
    clearTimeout(connectionTimer);
    try {
      await writeFile(
        path.join(out, responseFile),
        JSON.stringify({ requests, responses, publications }, null, 2),
      );
    } finally {
      try {
        await peer.stopAndWait();
      } finally {
        if (mode === "warm") {
          await writeFile(
            path.join(out, "warm-preparations.json"),
            JSON.stringify(preparations, null, 2),
          );
        }
      }
    }
  }
}

try {
  if (values["cold-backend"] || warmSetup) {
    assert.equal(process.env.TZ, "UTC", "Run backend readiness and warm filters with TZ=UTC");
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC");
    assert.equal(new Date().getTimezoneOffset(), 0);
  }
  for (let coldPair = 0; coldPair < (coldPairs ?? 1); coldPair++) {
    for (const [role, root] of [
      ["base-a", base],
      ["head", head],
      ["base-b", base],
    ] as const) {
      activeStep = { role, phase: "startup" };
      const owner = await start(root, role, coldPairs === undefined ? undefined : coldPair);
      owners.push(owner);
      if (values["cold-backend"]) {
        try {
          await prepareUsageBackend(
            owner,
            "cold",
            coldPairs === undefined ? undefined : coldPair + 1,
          );
        } finally {
          // Startup backfill must not overlap the next role's cold observation.
          await owner.close();
          owners.pop();
        }
      } else if (warmSetup) {
        await prepareUsageBackend(owner, "warm");
      }
    }
  }
  for (const cpu of values["cold-backend"]
    ? []
    : values.cold || values.diagnostic || values.structure || values["warm-sequence"]
      ? [1]
      : values.smoke
        ? [4]
        : warmCpu === undefined
          ? [1, 4]
          : [warmCpu]) {
    for (const rtt of values.cold
      ? [0]
      : values.structure
        ? [structureRtt]
        : values["warm-sequence"]
          ? [100]
          : [0, 100]) {
      const pages: PageEntry[] = [];
      try {
        for (const owner of owners) {
          activeStep = { role: owner.role, phase: "browser-setup", cpu, rtt };
          // Process metrics include every renderer in this browser, so each role owns one.
          const browser = await chromium.launch({
            headless: true,
            ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
              ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
              : {}),
          });
          browsers.add(browser);
          const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            locale: "en-US",
            timezoneId: "UTC",
            serviceWorkers: "block",
          });
          const page = await context.newPage();
          const entry: PageEntry = {
            owner,
            browser,
            processSession: await browser.newBrowserCDPSession(),
            context,
            page,
            cdp: await context.newCDPSession(page),
            proxy: undefined,
            usage: observeUsage(page),
            wire: values.structure ? observeWire(page) : undefined,
          };
          pages.push(entry);
          entry.proxy = rtt ? await startUsageRttProxy(owner.ready.port, 50) : undefined;
          const { cdp, proxy } = entry;
          page.setDefaultTimeout(60_000);
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
          await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
          await page.addInitScript(() =>
            localStorage.setItem(
              "openclaw:control-ui:community-invite:v2",
              JSON.stringify({ dismissedAtMs: 1770000000000 }),
            ),
          );
          if (values.structure) {
            await page.addInitScript("globalThis.__name = (fn) => fn");
          }
          if (values.diagnostic || values.structure) {
            await page.addInitScript(
              ({ watchModel01 }) => {
                // oxlint-disable-next-line typescript/unbound-method -- Forward the original socket receiver with call.
                const send = WebSocket.prototype.send;
                const requests = new WeakMap<WebSocket, Set<string>>();
                WebSocket.prototype.send = function (this: WebSocket, data) {
                  if (typeof data === "string") {
                    let frame;
                    try {
                      frame = JSON.parse(data);
                    } catch {
                      return send.call(this, data);
                    }
                    if (
                      frame?.type === "req" &&
                      frame.method === "sessions.usage" &&
                      (frame.params?.query === "model:fixture-model-00-end" ||
                        (watchModel01 && frame.params?.query === "model:fixture-model-01-end"))
                    ) {
                      let ids = requests.get(this);
                      if (!ids) {
                        ids = new Set();
                        requests.set(this, ids);
                        this.addEventListener("message", (event) => {
                          let response;
                          try {
                            response = JSON.parse(event.data);
                          } catch {
                            return;
                          }
                          if (requests.get(this)?.delete(response?.id)) {
                            // Observed in the page's message task, after earlier app listeners.
                            performance.mark("usage:response-observed");
                          }
                        });
                      }
                      ids.add(frame.id);
                    }
                  }
                  return send.call(this, data);
                };
              },
              { watchModel01: values["trace-adverse"] },
            );
          }
          const url = new URL(`http://127.0.0.1:${proxy?.port ?? owner.ready.port}/usage`);
          const gatewayUrl = `ws://${url.host}`;
          await page.addInitScript(({ key, token }) => sessionStorage.setItem(key, token), {
            key: `${CONTROL_UI_TOKEN_SESSION_KEY_PREFIX}${gatewayOriginScope(gatewayUrl)}`,
            token: owner.ready.token,
          });
        }
        for (const { owner, page, context, cdp, processSession, proxy, usage } of pages) {
          const { responses } = usage;
          activeStep = { role: owner.role, phase: "default-readiness", cpu, rtt, query: "" };
          const url = new URL(`http://127.0.0.1:${proxy?.port ?? owner.ready.port}/usage`);
          const defaultRendererBefore = await rendererProbe(processSession);
          const defaultCpuBefore = await readGatewayCpuUsage(owner.child);
          const defaultBrowserBefore = await metrics(cdp);
          const defaultDispatchBefore = (await owner.snapshot()).length;
          const defaultStarted = performance.now();
          await page.goto(url.href);
          await page.locator(".usage-query-input").waitFor();
          const defaultResponse = await waitForResponse(responses, 0, "");
          await settled(page, defaultResponse.sessions);
          const defaultWallMs = performance.now() - defaultStarted;
          const defaultBrowserAfter = await metrics(cdp);
          const defaultCpuAfter = await readGatewayCpuUsage(owner.child);
          const defaultRendererAfter = await rendererProbe(processSession);
          const expectedDefault = expectedRange(
            owner.ready,
            defaultResponse.startDate,
            defaultResponse.endDate,
          );
          assert.equal(
            defaultResponse.sessions,
            expectedDefault.sessions,
            "Complete default-range session count",
          );
          assert.equal(
            defaultResponse.tokens,
            expectedDefault.tokens,
            "Complete default-range token count",
          );
          samples.push({
            role: owner.role,
            phase: "default-readiness",
            cpu,
            rtt,
            wallMs: defaultWallMs,
            actionInterval: {
              startedMs: defaultStarted,
              finishedMs: defaultStarted + defaultWallMs,
            },
            browserResources: browserResources(
              defaultRendererBefore,
              defaultRendererAfter,
              defaultBrowserBefore,
              defaultBrowserAfter,
            ),
            gatewayCpu: measureGatewayCpuUsage(defaultCpuBefore, defaultCpuAfter),
            // Document counters reset across goto; whole-renderer CPU keeps the cold interval.
            browserCpuMs: null,
            browserCpuUnavailableReason: "Document counters reset across navigation",
            dispatches: (await owner.snapshot()).slice(defaultDispatchBefore),
            response: defaultResponse,
            load: os.loadavg(),
          });
          const coldDispatchBefore = (await owner.snapshot()).length;
          const coldRendererBefore = await rendererProbe(processSession);
          const coldCpuBefore = await readGatewayCpuUsage(owner.child);
          const coldBrowserBefore = await metrics(cdp);
          const coldStarted = performance.now();
          activeStep = { role: owner.role, phase: "population-range", cpu, rtt, query: "" };
          const coldRequestsBefore = responses.length;
          const dates = page.locator(".usage-date-range input");
          await dates.last().fill(owner.ready.endDate);
          await dates.last().press("Tab");
          await dates.first().fill(owner.ready.startDate);
          await dates.first().press("Tab");
          const coldResponse = await waitForResponse(responses, coldRequestsBefore, "", population);
          assert.equal(coldResponse.tokens, owner.ready.allTokens);
          await settled(page, population);
          const coldWallMs = performance.now() - coldStarted;
          const coldBrowserAfter = await metrics(cdp);
          const coldCpuAfter = await readGatewayCpuUsage(owner.child);
          const coldRendererAfter = await rendererProbe(processSession);
          samples.push({
            role: owner.role,
            phase: "population-range",
            cpu,
            rtt,
            wallMs: coldWallMs,
            actionInterval: { startedMs: coldStarted, finishedMs: coldStarted + coldWallMs },
            browserResources: browserResources(
              coldRendererBefore,
              coldRendererAfter,
              coldBrowserBefore,
              coldBrowserAfter,
            ),
            gatewayCpu: measureGatewayCpuUsage(coldCpuBefore, coldCpuAfter),
            browserCpuMs: measureBrowserCpu(coldBrowserBefore, coldBrowserAfter),
            dispatches: (await owner.snapshot()).slice(coldDispatchBefore),
            response: coldResponse,
            load: os.loadavg(),
          });
          if (values.structure) {
            // Served-build proof only; no requests or observers enter warm timing runs.
            const build = roleUiBuilds[owner.role];
            const observed = await page.evaluate(() => ({
              buildScript: document.getElementById("openclaw-control-ui-build-info")?.textContent,
              resources: performance.getEntriesByType("resource").map((resource) => resource.name),
            }));
            const index = await readFile(path.join(build.root, "index.html"), "utf8");
            const frozenScript =
              /<script[^>]*id="openclaw-control-ui-build-info"[^>]*>(.*?)<\/script>/u.exec(
                index,
              )?.[1];
            assert(frozenScript, "Frozen UI build identity missing");
            assert.equal(observed.buildScript, frozenScript, `${owner.role} served build identity`);
            const assetUrls = [...new Set(observed.resources)]
              .filter((resource) => {
                const asset = new URL(resource);
                return (
                  asset.origin === url.origin && /^\/assets\/.*\.(?:js|css)$/u.test(asset.pathname)
                );
              })
              .toSorted();
            assert(assetUrls.length > 0, `${owner.role} loaded no UI assets`);
            const assets = [];
            for (const assetUrl of assetUrls) {
              const relative = new URL(assetUrl).pathname.slice(1);
              const response = await context.request.get(assetUrl);
              assert.equal(response.status(), 200, `${owner.role} served ${relative}`);
              const bytes = await response.body();
              const sha256 = createHash("sha256").update(bytes).digest("hex");
              assert.equal(
                sha256,
                await hashFile(path.join(build.root, relative)),
                `${owner.role} served ${relative} bytes`,
              );
              assets.push({ path: relative, sha256, bytes: bytes.length });
              await response.dispose();
            }
            await writeFile(
              path.join(out, `served-ui-${owner.role}-${cpu}x-${rtt}ms.json`),
              JSON.stringify(
                { role: owner.role, build, buildScript: observed.buildScript, assets },
                null,
                2,
              ),
            );
          }
        }
        // Keep background GC between repeated filters inside the sequence interval.
        // Single-action samples stay unchanged; this does not force GC or wait for it.
        const sequenceBefore = new Map<
          PageEntry,
          {
            renderer: Awaited<ReturnType<typeof rendererProbe>>;
            document: Awaited<ReturnType<typeof metrics>>;
            load: number[];
          }
        >();
        if (values["warm-sequence"]) {
          const rendererOwners = new Map<number, string>();
          for (const entry of pages) {
            const renderer = await rendererProbe(entry.processSession);
            for (const { id } of renderer.processes) {
              assert(
                !rendererOwners.has(id),
                `Renderer ${id} is shared with ${rendererOwners.get(id)}`,
              );
              rendererOwners.set(id, entry.owner.role);
            }
            sequenceBefore.set(entry, {
              renderer,
              document: await metrics(entry.cdp),
              load: os.loadavg(),
            });
          }
        }
        const iterations = values.cold
          ? 0
          : values.structure
            ? 5
            : values.diagnostic
              ? 3
              : values.smoke
                ? 2
                : pairs * 2;
        for (let iteration = 0; iteration < iterations; iteration++) {
          const pair = Math.floor(iteration / 2);
          const order = pair % 2 ? pages.toReversed() : pages;
          for (const entry of order) {
            const { owner, page, cdp, processSession, usage } = entry;
            const { responses } = usage;
            const model = `fixture-model-${iteration % 2 ? "01" : "00"}-end`;
            const query = `model:${model}`;
            activeStep = { role: owner.role, phase: "filter", cpu, rtt, query, pair };
            const truth = owner.ready.models[model]!;
            const requestsBefore = responses.length;
            const dispatchBefore = (await owner.snapshot()).length;
            const condition =
              values.structure && values["trace-adverse"] && (iteration === 0 || iteration === 3)
                ? iteration === 0
                  ? "first-model00"
                  : "reset-model01"
                : values.structure && iteration >= 2 && iteration % 2 === 0
                  ? iteration === 2
                    ? "natural"
                    : "gc-conditioned"
                  : undefined;
            const retainedBefore =
              condition === "gc-conditioned" ? await browserRetention(cdp) : undefined;
            const diagnostic = (values.diagnostic && iteration === 2) || condition !== undefined;
            if (diagnostic) {
              await startUsageDiagnostic(
                entry,
                `${owner.role}-${cpu}x-${rtt}ms-${model.endsWith("00-end") ? "model00" : "model01"}${condition ? `-${condition}` : ""}`,
              );
            }
            if (condition) {
              await startUsageStructure(entry);
            }
            const wireStart = entry.wire?.length;
            const rendererBefore = await rendererProbe(processSession);
            const cpuBefore = await readGatewayCpuUsage(owner.child);
            const browserBefore = await metrics(cdp);
            const started = performance.now();
            if (diagnostic) {
              await page.evaluate(() => performance.mark("usage:action-start"));
            }
            await page.locator(".usage-query-input").fill(query);
            await page.locator(".usage-query-input").press("Enter");
            const response = await waitForResponse(responses, requestsBefore, query);
            assert.equal(response.tokens, truth.tokens);
            assert.equal(response.sessions, truth.sessions);
            await settled(page, truth.sessions, diagnostic);
            const wallMs = performance.now() - started;
            if (diagnostic) {
              await page.evaluate(() => performance.mark("usage:action-end"));
            }
            const browserAfter = await metrics(cdp);
            const cpuAfter = await readGatewayCpuUsage(owner.child);
            const rendererAfter = await rendererProbe(processSession);
            const structure = await entry.finishStructure?.();
            const wireEnd = entry.wire?.length;
            if (diagnostic) {
              await page.evaluate(() => performance.mark("usage:probe-end"));
              await entry.finishDiagnostic?.();
            }
            const retainedAfter =
              condition === "gc-conditioned" ? await browserRetention(cdp) : undefined;
            const dispatches = (await owner.snapshot()).slice(dispatchBefore);
            if (owner.role === "head") {
              assert.deepEqual(
                dispatches.map(({ kind }) => kind),
                ["cohorts"],
                "Candidate model filter must use one prepared cohort task",
              );
              assert.equal(dispatches[0]!.packedBytes, 0, "No packed rows resent on warm filters");
            }
            assert((await page.locator(".session-bar-row").count()) <= 50);
            const delta = measureBrowserCpu(browserBefore, browserAfter);
            samples.push({
              role: owner.role,
              phase: "filter",
              diagnostic,
              ...(condition ? { condition, structure, retainedBefore, retainedAfter } : {}),
              ...(entry.wire ? { wireStart, wireEnd } : {}),
              pair,
              cpu,
              rtt,
              model,
              wallMs,
              actionInterval: { startedMs: started, finishedMs: started + wallMs },
              browserResources: browserResources(
                rendererBefore,
                rendererAfter,
                browserBefore,
                browserAfter,
              ),
              browserCpuMs: delta,
              gatewayCpu: measureGatewayCpuUsage(cpuBefore, cpuAfter),
              dispatches,
              response,
              load: os.loadavg(),
            });
            await writeFile(path.join(out, "samples.json"), JSON.stringify(samples, null, 2));
          }
        }
        if (values["warm-sequence"]) {
          for (const entry of pages) {
            const before = sequenceBefore.get(entry)!;
            const documentAfter = await metrics(entry.cdp);
            const rendererAfter = await rendererProbe(entry.processSession);
            const actions = samples.filter(
              (sample) =>
                sample.phase === "filter" &&
                sample.role === entry.owner.role &&
                sample.cpu === cpu &&
                sample.rtt === rtt,
            );
            assert.equal(actions.length, iterations);
            sequences.push({
              role: entry.owner.role,
              cpu,
              rtt,
              pairs,
              actions: actions.length,
              rendererPids: before.renderer.processes.map(({ id }) => id),
              browserResources: browserResources(
                before.renderer,
                rendererAfter,
                before.document,
                documentAfter,
              ),
              browserCpuMs: measureBrowserCpu(before.document, documentAfter),
              loadBefore: before.load,
              loadAfter: os.loadavg(),
            });
            await writeFile(path.join(out, "sequences.json"), JSON.stringify(sequences, null, 2));
          }
        }
        for (const { owner } of pages) {
          await writeFile(
            path.join(out, `${owner.role}-${cpu}x-${rtt}ms-resources.json`),
            JSON.stringify(
              await readGatewayResources(owner.child, {
                includeWorkers: true,
                collectGarbage: true,
              }),
              null,
              2,
            ),
          );
        }
      } finally {
        for (const entry of pages.toReversed()) {
          try {
            await writeFile(
              path.join(out, `${entry.owner.role}-${cpu}x-${rtt}ms-responses.json`),
              JSON.stringify(
                {
                  lastStep: activeStep,
                  pending: Object.fromEntries(entry.usage.pending),
                  responses: entry.usage.responses,
                  errors: entry.usage.errors,
                },
                null,
                2,
              ),
            );
          } catch (error) {
            failures.push(`${entry.owner.role} response diagnostics: ${errorText(error)}`);
          }
          if (entry.wire) {
            try {
              await writeFile(
                path.join(out, `${entry.owner.role}-wire.json`),
                JSON.stringify(entry.wire, null, 2),
              );
            } catch (error) {
              failures.push(`${entry.owner.role} wire capture: ${errorText(error)}`);
            }
          }
          try {
            await entry.finishStructure?.();
          } catch (error) {
            failures.push(`${entry.owner.role} structural cleanup: ${errorText(error)}`);
          }
          try {
            await entry.finishDiagnostic?.();
          } catch (error) {
            failures.push(`${entry.owner.role} diagnostic cleanup: ${errorText(error)}`);
          }
          for (const cdp of [entry.processSession, entry.cdp]) {
            try {
              await cdp.detach();
            } catch (error) {
              failures.push(`${entry.owner.role} CDP cleanup: ${errorText(error)}`);
            }
          }
          try {
            await entry.context.close();
          } catch (error) {
            failures.push(`${entry.owner.role} browser context cleanup: ${errorText(error)}`);
          }
          try {
            await entry.browser.close();
            browsers.delete(entry.browser);
          } catch (error) {
            failures.push(`${entry.owner.role} browser cleanup: ${errorText(error)}`);
          }
          try {
            await entry.proxy?.close();
          } catch (error) {
            failures.push(`${entry.owner.role} relay cleanup: ${errorText(error)}`);
          }
        }
      }
    }
  }
} catch (error) {
  failures.push(`${JSON.stringify(activeStep)}: ${errorText(error)}`);
} finally {
  for (const browser of browsers) {
    try {
      await browser.close();
    } catch (error) {
      failures.push(`Browser cleanup: ${errorText(error)}`);
    }
  }
  for (const owner of owners.toReversed()) {
    try {
      await owner.close();
    } catch (error) {
      failures.push(`${owner.role} cleanup: ${errorText(error)}`);
    }
  }
  for (const [role, retained] of coldFixtures) {
    if (!retained.available) {
      failures.push(`${role} fixture retained: previous process tree did not drain`);
      continue;
    }
    try {
      await rm(retained.fixture.root, { recursive: true, force: true });
      await rm(retained.pristine, { recursive: true, force: true });
      await retained.claim.release();
    } catch (error) {
      failures.push(`${role} cold fixture cleanup: ${errorText(error)}`);
    }
  }
  try {
    assert.deepEqual(
      await helperHashes(),
      helperSources,
      "Shared benchmark helpers changed during proof",
    );
    for (const build of new Set(Object.values(roleUiBuilds))) {
      assert.deepEqual(
        { root: build.root, ...(await hashInstall(build.root)) },
        build,
        "Frozen UI changed during proof",
      );
    }
  } catch (error) {
    failures.push(`Helper identity after cleanup: ${errorText(error)}`);
  }
  for (const before of buildRoots.values()) {
    try {
      assert.deepEqual(
        await inspectBuild(before.root),
        before,
        `${before.root}: runtime or source changed during proof`,
      );
    } catch (error) {
      failures.push(`Build identity after cleanup: ${errorText(error)}`);
    }
  }
  await writeFile(path.join(out, "samples.json"), JSON.stringify(samples, null, 2));
  await writeFile(
    path.join(out, "completion.json"),
    JSON.stringify(
      {
        failures,
        lastStep: activeStep,
        preparationSamples: preparations.length,
        samples: samples.length,
        browserResourceSamples: samples.filter((sample) => sample.browserResources?.complete)
          .length,
        mode: values["cold-backend"]
          ? coldPairs === undefined
            ? "fresh-backend-cold-triple"
            : "restored-backend-cold-pairs"
          : values.structure
            ? "structural-attribution-only"
            : values.cold
              ? "fresh-cold-triple"
              : values.diagnostic
                ? "attribution-only"
                : values["warm-sequence"]
                  ? "warm-sequence"
                  : "warm",
        coldPairs: coldPairs ?? null,
        ...(values["warm-sequence"] ? { sequenceObservations: sequences.length } : {}),
        ...(warmCpu === undefined ? {} : { warmCpu }),
        pairsPerQuery:
          values.cold || values["cold-backend"]
            ? 0
            : values.diagnostic || values.structure
              ? null
              : values.smoke
                ? 1
                : pairs,
        queries:
          values.cold || values["cold-backend"]
            ? []
            : ["model:fixture-model-00-end", "model:fixture-model-01-end"],
        limitations: values["cold-backend"]
          ? `Backend-only at native CPU and localhost: the first sessions.usage RPC requests the full 180 days with the browser's specific-UTC date mode and ordinary overview/sort options; no preceding browser/default-range request. Exactly one Gateway is alive at a time, including startup and drain. Startup backfill remains enabled. Every partial response is retained; successful Usage publications trigger coalesced re-reads within one unchanged 60-second deadline. First-response and complete-ready wall/CPU metrics are separate, and every request retains its CPU snapshots and aggregation dispatches. ${coldPairs === undefined ? "One fresh triple, fixed A/H/C order, not repeated qualification." : `${coldPairs} serial A/H/C triples; seed-once pristine snapshots restored at the exact original absolute path only after process-tree drain. Every role keeps its port/token and launches a fresh compiled process per triple. File bytes and symlink targets match the pre-Gateway snapshot; filesystem cache is not cold.`} Worker CPU snapshots include newly observed or retired workers without claiming complete interval coverage. Resources follow the response with main-only forced GC and asynchronously cached worker heaps. No browser measurements.`
          : values.structure
            ? `Structural attribution only, native CPU and ${structureRtt}ms added RTT. Each role warms model00/model01, traces a natural model00 return, resets model01 outside the traced action, then traces a model00 return after forced browser GC. The second trace has forced-GC heap/DOM counters before and after, outside timing. Passive mutation counts and local node IDs contain no DOM text or attributes; metadata-only wire records contain no payloads. Instrumented timing is not acceptance evidence. Preserve earlier warm and cold regressions.`
            : "Backend runs at native CPU; 1x/4x applies only to Chromium. Non-navigation browser metrics use threadTicks; default-readiness document CPU is unavailable because navigation resets those counters. Each role owns an isolated browser. Whole-renderer CPU and RSS probes bracket each action; their recorded bounds include collection overhead outside wall/main-thread intervals. Heap and RSS are sampled endpoints, not retained heap, peaks, or GPU memory. " +
              (headUi === ui
                ? "Same frozen UI for all roles. "
                : "The head uses --head-ui; both controls use --ui. Per-role build hashes are recorded in helper-sources.json. ") +
              "Population has one/two actual turns per session spread over180days. Durable source seeding and compiled startup recorded separately; no source server. Setup logs retained. No provider calls. " +
              (warmSetup
                ? " Before browsers start, each compiled Gateway completes a publication-driven full-range Usage preparation; every preparation reply/publication is separate from measured samples in warm-preparations.json. Preparation uses UTC dates and is bounded by the Gateway's existing managed lifetime. "
                : "No report prewarming. ") +
              (values.cold
                ? "One fresh, independently seeded Gateway/browser per role, measuring default then first full-range request at native CPU and localhost. One invocation is one triple, not repeated cold qualification."
                : "Gateway reused across CPU/RTT cells; default/readiness and population-range phases are not independent cold-process samples.") +
              (values.diagnostic
                ? " Traced actions are attribution only, never timing acceptance."
                : "") +
              (values["warm-sequence"]
                ? " One additional renderer/document interval spans all repeated filters and their intervening ordinary idle time for each role at 1x/100ms, preserving every action sample. It includes measurement overhead and background work; it ends at the ordinary settled outcome without forcing or waiting for GC. Heap deltas are net endpoints, not total allocations or retained memory."
                : ""),
      },
      null,
      2,
    ),
  );
}
assert.equal(failures.length, 0, failures.join("\n"));
