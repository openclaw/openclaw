// Installed, serial AB update workload. Never point it at an existing installation/state.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { hasErrnoCode } from "../../src/infra/errno.js";
import { createNpmFreshnessBypassArgs } from "../../src/infra/npm-install-env.js";
import type { UpdateRunRecord } from "../../src/infra/update-run-record.js";
import { readCommandProcessStartTime } from "../../src/process/command-process-identity.js";
import { isPidDefinitelyDeadAsync } from "../../src/shared/pid-alive.js";
import { acquireTestPortBlock } from "../../src/test-utils/port-claims.js";
import { terminateManagedChild } from "../lib/managed-child-process.mts";

const pluginNames = ["a", "b", "c", "d"].map((id) => "update-prefetch-perf-" + id);
const ordinaryPayload = Buffer.alloc(1024, 42);
const delayMs = 3000;
type Options = {
  label: string;
  samples: number;
  sourceRoot: string;
  driver: string;
  baseline: string;
  candidate: string;
};
type Archive = {
  file: string;
  size: number;
  sha256: string;
  integrity: string;
  manifest: Record<string, unknown>;
};
type PluginArchive = { name: string; version: string; file: string; integrity: string };
type ArchiveEvent = {
  name: string;
  version: string;
  startedAtMs: number;
  finishedAtMs?: number;
  completed?: boolean;
  readyBefore: boolean;
  readyAfter?: boolean;
};
type Probe = { atMs: number; ready: boolean; durationMs: number };
type Row = {
  label: string;
  sample: number;
  totalMs: number;
  observedMs: number;
  downtimeMs: number;
  selectedGets: number;
  getsAfterStop: number;
  runId: string;
  runningBuildId: unknown;
  resourcesBefore: unknown;
  resourcesAfter: unknown;
};

async function archive(file: string): Promise<Archive> {
  const sha256 = createHash("sha256"),
    sha512 = createHash("sha512");
  for await (const bytes of createReadStream(file)) {
    sha256.update(bytes);
    sha512.update(bytes);
  }
  const manifest: Record<string, unknown> = JSON.parse(
    execFileSync("tar", ["-xOf", file, "package/package.json"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
  assert.equal(manifest.name, "openclaw");
  assert.equal(typeof manifest.version, "string");
  return {
    file,
    size: (await fs.stat(file)).size,
    sha256: sha256.digest("hex"),
    integrity: "sha512-" + sha512.digest("base64"),
    manifest,
  };
}

async function resources() {
  const observations: Record<string, string | null> = {};
  for (const file of [
    "cpu.stat",
    "cpu.max",
    "io.stat",
    "memory.current",
    "memory.max",
    "cpu.pressure",
    "io.pressure",
  ]) {
    observations[file] = await fs.readFile("/sys/fs/cgroup/" + file, "utf8").catch(() => null);
  }
  return {
    atMs: Date.now(),
    loadavg: loadavg(),
    cpus: availableParallelism(),
    cgroup: observations,
    harness: process.resourceUsage(),
  };
}

async function command(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  output: string,
  timeoutMs = 120000,
) {
  const stdout = await fs.open(output + ".stdout", "w"),
    stderr = await fs.open(output + ".stderr", "w");
  const child = spawn(bin, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", stdout.fd, stderr.fd],
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateManagedChild(child, "SIGTERM", { useProcessGroup: true });
  }, timeoutMs);
  const force = setTimeout(
    () => terminateManagedChild(child, "SIGKILL", { useProcessGroup: true }),
    timeoutMs + 5000,
  );
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.ok(!timedOut, "Command exceeded its observation budget: " + output);
    return { code, text: await fs.readFile(output + ".stdout", "utf8") };
  } finally {
    clearTimeout(timer);
    clearTimeout(force);
    await stdout.close();
    await stderr.close();
  }
}

function environment(root: string, prefix: string): NodeJS.ProcessEnv {
  // Preserve transport/exec attribution, but never pass model/provider credentials to fixtures.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(PATH|LANG|LC_ALL|TZ|SHELL|TMPDIR|TMP|TEMP|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR)$/u.test(
        key,
      ) ||
      key.startsWith("OPENCLAW_EXEC_")
    ) {
      env[key] = value;
    }
  }
  const cache = path.join(root, "cache"),
    home = path.join(root, "home");
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "state/openclaw.json"),
    XDG_CACHE_HOME: cache,
    GOMAXPROCS: "2",
    RAYON_NUM_THREADS: "2",
    NO_COLOR: "1",
    CI: "1",
    PATH: prefix + "/bin:" + (env.PATH ?? ""),
  });
  for (const [key, value] of Object.entries({
    prefix,
    cache,
    userconfig: path.join(root, "user.npmrc"),
    globalconfig: path.join(root, "global.npmrc"),
  })) {
    env["npm_config_" + key] = value;
    env["NPM_CONFIG_" + key.toUpperCase()] = value;
  }
  env.NO_PROXY = [env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
  env.no_proxy = env.NO_PROXY;
  return env;
}

async function makePlugins(root: string): Promise<PluginArchive[]> {
  const env = environment(root, path.join(root, "prefix"));
  for (const dir of ["home", "cache"]) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  await fs.writeFile(path.join(root, "user.npmrc"), "");
  await fs.writeFile(path.join(root, "global.npmrc"), "");
  const archives: PluginArchive[] = [];
  for (const name of pluginNames) {
    for (const version of ["1.0.0", "2.0.0"]) {
      const dir = path.join(root, name + "-" + version);
      await fs.mkdir(path.join(dir, "payload"), { recursive: true });
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name, version, type: "module", openclaw: { extensions: ["./index.js"] } }),
      );
      await fs.writeFile(
        path.join(dir, "openclaw.plugin.json"),
        JSON.stringify({ id: name, configSchema: { type: "object", properties: {} } }),
      );
      await fs.writeFile(
        path.join(dir, "index.js"),
        "export default { id: " + JSON.stringify(name) + ", register() {} };\n",
      );
      for (let file = 0; file < 128; file++) {
        await fs.writeFile(path.join(dir, "payload", file + ".bin"), randomBytes(8192));
      }
      const result = await command(
        "npm",
        ["pack", "--ignore-scripts", "--pack-destination", root, dir],
        root,
        env,
        path.join(root, name + "-" + version + "-pack"),
      );
      assert.equal(result.code, 0);
      const file = path.join(root, name + "-" + version + ".tgz");
      archives.push({
        name,
        version,
        file,
        integrity:
          "sha512-" +
          createHash("sha512")
            .update(await fs.readFile(file))
            .digest("base64"),
      });
    }
  }
  return archives;
}

async function runSample(
  root: string,
  label: string,
  sample: number,
  driver: Archive,
  target: Archive,
  plugins: PluginArchive[],
): Promise<Row> {
  await fs.mkdir(root); // Refuse reuse of a partial/uncertain sample.
  const prefix = path.join(root, "prefix"),
    pkg = path.join(prefix, "lib/node_modules/openclaw"),
    cli = path.join(pkg, "openclaw.mjs");
  const env = environment(root, prefix),
    profile = "prefetch-" + label + "-" + sample;
  for (const dir of ["home", "state", "workspace", "cache"]) {
    await fs.mkdir(path.join(root, dir));
  }
  await fs.writeFile(path.join(root, "global.npmrc"), "");
  await fs.writeFile(path.join(root, "user.npmrc"), "cache=" + env.npm_config_cache + "\n");
  const install = await command(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      ...createNpmFreshnessBypassArgs(env, new Date(), { npmConfigPrefix: prefix }),
      driver.file,
    ],
    root,
    env,
    path.join(root, "driver-install"),
    300000,
  );
  assert.equal(install.code, 0);
  assert.equal(await fs.realpath(pkg), pkg);
  env.GIT_CEILING_DIRECTORIES = path.dirname(pkg);
  env.OPENCLAW_PROFILE = profile;
  const claim = await acquireTestPortBlock({ offsets: [0, 1, 2] });
  env.OPENCLAW_GATEWAY_PORT = String(claim.port);
  env.OPENCLAW_GATEWAY_TOKEN = "synthetic-prefetch-benchmark-token";
  const probe = async (): Promise<Probe> => {
    const atMs = Date.now();
    let ready = false;
    try {
      ready = (
        await fetch("http://127.0.0.1:" + claim.port + "/readyz", {
          signal: AbortSignal.timeout(500),
        })
      ).ok;
    } catch {
      /* unavailable is the measured outcome */
    }
    return { atMs, ready, durationMs: Date.now() - atMs };
  };
  let latest = "1.0.0",
    registry = "",
    measuring = false;
  const probeController = new AbortController();
  const events: ArchiveEvent[] = [],
    probes: Probe[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", registry),
        name = decodeURIComponent(url.pathname.slice(1));
      if (name === "openclaw") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            name,
            "dist-tags": { latest: target.manifest.version },
            versions: {
              [String(target.manifest.version)]: {
                ...target.manifest,
                dist: { integrity: target.integrity, tarball: registry + "/openclaw/-/target.tgz" },
              },
            },
          }),
        );
        return;
      }
      if (url.pathname === "/openclaw/-/target.tgz") {
        response.setHeader("content-length", String(target.size));
        createReadStream(target.file).pipe(response);
        return;
      }
      if (pluginNames.includes(name)) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            name,
            "dist-tags": { latest },
            versions: Object.fromEntries(
              plugins
                .filter((p) => p.name === name)
                .map((p) => [
                  p.version,
                  {
                    name,
                    version: p.version,
                    dist: {
                      integrity: p.integrity,
                      tarball: registry + "/" + name + "/-/" + path.basename(p.file),
                    },
                  },
                ]),
            ),
          }),
        );
        return;
      }
      const selected = plugins.find(
        (p) => url.pathname === "/" + p.name + "/-/" + path.basename(p.file),
      );
      if (selected) {
        const event: ArchiveEvent = {
          name: selected.name,
          version: selected.version,
          startedAtMs: Date.now(),
          readyBefore: (await probe()).ready,
        };
        if (measuring) {
          events.push(event);
        }
        if (selected.version === "2.0.0") {
          await sleep(delayMs);
        }
        response.setHeader("content-length", String((await fs.stat(selected.file)).size));
        await new Promise<void>((resolve, reject) => {
          response.once("finish", resolve);
          response.once("close", () => {
            if (!response.writableFinished) {
              reject(new Error("Archive response aborted"));
            }
          });
          const stream = createReadStream(selected.file);
          stream.once("error", reject);
          stream.pipe(response);
        });
        event.completed = true;
        event.finishedAtMs = Date.now();
        event.readyAfter = (await probe()).ready;
        return;
      }
      response.writeHead(307, {
        location: "https://registry.npmjs.org" + url.pathname + url.search,
      });
      response.end();
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  registry = "http://127.0.0.1:" + address.port;
  env.npm_config_registry = registry;
  env.NPM_CONFIG_REGISTRY = registry;
  await fs.writeFile(
    path.join(root, "user.npmrc"),
    "cache=" + env.npm_config_cache + "\nregistry=" + registry + "\n",
  );
  const invoke = (name: string, args: string[]) =>
    command(
      process.execPath,
      [cli, "--profile", profile, ...args],
      pkg,
      env,
      path.join(root, name),
    );
  let gateway: ReturnType<typeof spawn> | undefined,
    gatewayDone: Promise<unknown> | undefined,
    gatewayLog: Awaited<ReturnType<typeof fs.open>> | undefined,
    probeLoop: Promise<void> | undefined;
  let requestAttempted = false,
    terminal = false,
    requestedAt = 0;
  let requestRunId: string | undefined;
  let run: UpdateRunRecord | undefined;
  const databasePaths = [
    path.join(root, "state/state/openclaw.sqlite"),
    path.join(root, "state/agents/main/agent/openclaw-agent.sqlite"),
  ];
  let outcome: { ok: true; row: Row } | { ok: false; error: unknown };
  try {
    assert.equal(
      (await invoke("setup", ["setup", "--baseline", "--workspace", path.join(root, "workspace")]))
        .code,
      0,
    );
    for (const name of pluginNames) {
      assert.equal(
        (
          await invoke("install-" + name, [
            "plugins",
            "install",
            "npm:" + name + "@latest",
            "--accept-capabilities",
          ])
        ).code,
        0,
      );
    }
    assert.equal(
      (
        await invoke("prepare-stores", [
          "doctor",
          "--fix",
          "--non-interactive",
          "--no-workspace-suggestions",
        ])
      ).code,
      0,
    );
    // Expand only stores created by the released owner after its CLI writers have joined.
    for (const [index, file] of databasePaths.entries()) {
      assert.ok((await fs.stat(file)).isFile(), "Released owner did not create " + file);
      using db = new DatabaseSync(file);
      db.exec("CREATE TABLE synthetic_prefetch_payload(value BLOB); BEGIN");
      const insert = db.prepare(
        "INSERT INTO synthetic_prefetch_payload VALUES (zeroblob(1048576))",
      );
      for (let row = 0; row < (index === 0 ? 128 : 64); row++) {
        insert.run();
      }
      db.exec("COMMIT");
    }
    const payloadDir = path.join(root, "state/benchmark-payload");
    await fs.mkdir(payloadDir);
    for (let file = 0; file < 4096; file++) {
      await fs.writeFile(path.join(payloadDir, file + ".bin"), ordinaryPayload);
    }
    const preview = await invoke("dry-run", ["update", "--dry-run", "--yes", "--json"]);
    const selection: { root: string; mode: string; currentVersion: string; targetVersion: string } =
      JSON.parse(preview.text);
    assert.equal(preview.code, 0);
    assert.equal(selection.root, pkg);
    assert.equal(selection.mode, "npm");
    assert.equal(selection.currentVersion, driver.manifest.version);
    assert.equal(selection.targetVersion, target.manifest.version);
    gatewayLog = await fs.open(path.join(root, "gateway.log"), "w");
    gateway = spawn(
      process.execPath,
      [
        cli,
        "--profile",
        profile,
        "gateway",
        "run",
        "--bind",
        "loopback",
        "--port",
        String(claim.port),
        "--auth",
        "token",
      ],
      { cwd: pkg, env, stdio: ["ignore", gatewayLog.fd, gatewayLog.fd] },
    );
    gatewayDone = new Promise((resolve) => {
      gateway!.once("exit", resolve);
    });
    const startDeadline = Date.now() + 90000;
    while (!(await probe()).ready && Date.now() < startDeadline && gateway.exitCode === null) {
      await sleep(200);
    }
    assert.ok((await probe()).ready, "Released Gateway must be ready before request");
    latest = "2.0.0";
    const resourcesBefore = await resources();
    requestedAt = Date.now();
    measuring = true;
    probeLoop = (async () => {
      while (!probeController.signal.aborted) {
        probes.push(await probe());
        await sleep(200);
      }
    })();
    requestAttempted = true;
    const request = await invoke("request", [
      "gateway",
      "call",
      "update.run",
      "--url",
      "ws://127.0.0.1:" + claim.port,
      "--token",
      env.OPENCLAW_GATEWAY_TOKEN!,
      "--params",
      JSON.stringify({ timeoutMs: 240000, note: "Synthetic paired plugin-prefetch benchmark" }),
      "--timeout",
      "30000",
      "--json",
    ]);
    const reply: { runId: string; handoff?: { status: string } } = JSON.parse(request.text);
    requestRunId = reply.runId;
    assert.equal(request.code, 0);
    assert.equal(reply.handoff?.status, "started");
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      const status = await invoke("status", ["update", "status", "--json"]);
      try {
        const snapshot: { activeRun?: UpdateRunRecord; lastRun?: UpdateRunRecord } = JSON.parse(
          status.text,
        );
        run = [snapshot.activeRun, snapshot.lastRun].find((r) => r?.runId === reply.runId);
      } catch {
        /* package replacement can invalidate an in-flight read */
      }
      if (run && ["succeeded", "failed", "skipped", "rolled-back"].includes(run.status)) {
        terminal = true;
        break;
      }
      await sleep(3000);
    }
    const observedMs = Date.now() - requestedAt,
      resourcesAfter = await resources();
    probeController.abort();
    await probeLoop;
    measuring = false;
    assert.ok(
      terminal && run,
      "Accepted update has not settled; preserve fixture and do not replay",
    );
    assert.equal(run.status, "succeeded");
    assert.equal(run.verification?.versionMatch, true);
    assert.equal(run.verification?.booted, true);
    assert.equal(run.verification?.serviceRunning, true);
    assert.deepEqual(run.verification?.pluginErrors, []);
    assert.ok((await probe()).ready);
    const firstLoss = probes.findIndex((p) => !p.ready);
    assert.ok(firstLoss >= 0, "No observed downtime");
    const finalRecovery = probes.findLastIndex(
      (p, i) => p.ready && i > firstLoss && !probes[i - 1]?.ready,
    );
    assert.ok(finalRecovery > firstLoss);
    const downtimeMs =
      probes[finalRecovery]!.atMs + probes[finalRecovery]!.durationMs - probes[firstLoss]!.atMs;
    const selected = events.filter((e) => e.version === "2.0.0");
    assert.equal(selected.length, pluginNames.length);
    assert.ok(selected.every((event) => event.completed && event.finishedAtMs));
    const getsAfterStop = selected.filter((e) => e.startedAtMs >= probes[firstLoss]!.atMs).length;
    if (label === "candidate") {
      assert.equal(getsAfterStop, 0);
      assert.ok(selected.every((e) => e.readyBefore && e.readyAfter));
    } else {
      assert.equal(getsAfterStop, pluginNames.length);
    }
    const list = await invoke("plugins", ["plugins", "list", "--json"]);
    const installed: {
      plugins: { id: string; version: string; status: string; rootDir: string }[];
    } = JSON.parse(list.text);
    assert.equal(list.code, 0);
    for (const name of pluginNames) {
      const item = installed.plugins.find((p) => p.id === name);
      assert.ok(item);
      assert.equal(item.version, "2.0.0");
      assert.equal(item.status, "loaded");
      const lock: { packages: Record<string, { integrity?: string }> } = JSON.parse(
        await fs.readFile(
          path.join(path.dirname(path.dirname(item.rootDir)), "package-lock.json"),
          "utf8",
        ),
      );
      assert.equal(
        lock.packages["node_modules/" + name]?.integrity,
        plugins.find((p) => p.name === name && p.version === "2.0.0")!.integrity,
      );
    }
    assert.ok(run.finishedAtMs);
    const row: Row = {
      label,
      sample,
      totalMs: run.finishedAtMs - run.createdAtMs,
      observedMs,
      downtimeMs,
      selectedGets: selected.length,
      getsAfterStop,
      runId: run.runId,
      runningBuildId: run.verification?.runningBuildId,
      resourcesBefore,
      resourcesAfter,
    };
    await fs.writeFile(
      path.join(root, "result.json"),
      JSON.stringify(
        {
          ...row,
          run,
          events,
          probes,
          tuple: {
            pkg,
            state: env.OPENCLAW_STATE_DIR,
            home: env.HOME,
            config: env.OPENCLAW_CONFIG_PATH,
            profile,
          },
        },
        null,
        2,
      ),
    );
    outcome = { ok: true, row };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    probeController.abort();
    await probeLoop;
    if (requestAttempted && !terminal) {
      // A lost RPC receipt is uncertain acceptance, never permission to stop an updater.
      try {
        const observed = await invoke("uncertain-status", ["update", "status", "--json"]);
        const snapshot: { activeRun?: UpdateRunRecord; lastRun?: UpdateRunRecord } = JSON.parse(
          observed.text,
        );
        run = [snapshot.activeRun, snapshot.lastRun].find(
          (candidateRun) =>
            candidateRun &&
            (requestRunId
              ? candidateRun.runId === requestRunId
              : candidateRun.trigger === "api" && candidateRun.createdAtMs >= requestedAt),
        );
        terminal =
          run !== undefined &&
          ["succeeded", "failed", "skipped", "rolled-back"].includes(run.status);
      } catch {
        /* Keep the uncertain owner and its fixture intact. */
      }
      if (!terminal) {
        await fs.writeFile(
          path.join(root, "retained.json"),
          JSON.stringify({
            reason: "update acceptance or settlement unresolved",
            requestRunId,
            requestedAt,
          }),
        );
      }
    }
    if (!requestAttempted || terminal) {
      const stopped: { pid: number; startedAt: number }[] = [];
      // Only typed Gateways with this exact private state selector may be stopped.
      for (const id of (await fs.readdir("/proc")).filter((entry) => /^\d+$/u.test(entry))) {
        let owned = false;
        try {
          const entries = (await fs.readFile("/proc/" + id + "/environ", "utf8")).split("\0");
          if (!entries.includes("OPENCLAW_STATE_DIR=" + env.OPENCLAW_STATE_DIR)) {
            continue;
          }
          owned = true;
          const args = (await fs.readFile("/proc/" + id + "/cmdline", "utf8")).split("\0");
          if (
            (args.includes("gateway") && args.includes("run")) ||
            args[0]?.startsWith("openclaw-gateway")
          ) {
            const pid = Number(id);
            const startedAt = await readCommandProcessStartTime(pid);
            assert.ok(startedAt !== null, "Cannot identify owned Gateway before shutdown");
            stopped.push({ pid, startedAt });
            process.kill(pid, "SIGTERM");
          }
        } catch (error) {
          if (owned && !hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ESRCH")) {
            throw error;
          }
        }
      }
      for (const pid of [gateway?.pid, run?.verification?.pid]) {
        if (typeof pid === "number" && !(await isPidDefinitelyDeadAsync(pid))) {
          assert.ok(
            stopped.some((identity) => identity.pid === pid),
            "Could not identify recorded Gateway for shutdown",
          );
        }
      }
      const shutdownDeadline = Date.now() + 15000;
      let pending = stopped;
      while (pending.length && Date.now() < shutdownDeadline) {
        const live: typeof stopped = [];
        for (const identity of pending) {
          if (await isPidDefinitelyDeadAsync(identity.pid)) {
            continue;
          }
          const currentStart = await readCommandProcessStartTime(identity.pid);
          if (currentStart === null || currentStart === identity.startedAt) {
            live.push(identity);
          }
        }
        pending = live;
        if (pending.length) {
          await sleep(100);
        }
      }
      await fs.writeFile(path.join(root, "shutdown.json"), JSON.stringify({ stopped, pending }));
      assert.equal(pending.length, 0, "Owned replacement Gateway has not exited; keep fixture");
      if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
        assert.ok(
          await Promise.race([gatewayDone!.then(() => true), sleep(15000, false, { ref: false })]),
          "Original Gateway exit did not settle",
        );
      }
      assert.equal(
        (await probe()).ready,
        false,
        "Owned Gateway endpoint still serves after shutdown",
      );
      await gatewayLog?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await claim.release();
      if (run?.status === "succeeded") {
        for (const [index, file] of databasePaths.entries()) {
          using db = new DatabaseSync(file, { readOnly: true });
          assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
          assert.equal(
            db
              .prepare(
                "SELECT count(*) AS n FROM synthetic_prefetch_payload WHERE value=zeroblob(1048576)",
              )
              .get()?.n,
            index === 0 ? 128 : 64,
          );
        }
        const payloadDir = path.join(root, "state/benchmark-payload");
        assert.equal((await fs.readdir(payloadDir)).length, 4096);
        for (let file = 0; file < 4096; file++) {
          assert.ok(
            (await fs.readFile(path.join(payloadDir, file + ".bin"))).equals(ordinaryPayload),
          );
        }
        await fs.writeFile(
          path.join(root, "verified.json"),
          JSON.stringify({
            gatewayStopped: true,
            databaseIntegrity: true,
            payloadsPreserved: true,
          }),
        );
      }
    }
  } catch (error) {
    if (!outcome.ok) {
      throw new AggregateError([outcome.error, error], "Update workload and cleanup both failed", {
        cause: error,
      });
    }
    throw error;
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.row;
}

export async function measurePluginPrefetch(options: Options): Promise<void> {
  assert.equal(
    process.platform,
    "linux",
    "This native-ownership workload currently qualifies Linux only",
  );
  assert.ok(Number.isSafeInteger(options.samples) && options.samples >= 5);
  const root = path.resolve(".artifacts/update-plugin-prefetch-" + options.label);
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.mkdir(root);
  const driver = await archive(path.resolve(options.driver)),
    baseline = await archive(path.resolve(options.baseline)),
    candidate = await archive(path.resolve(options.candidate));
  assert.equal(baseline.manifest.version, candidate.manifest.version);
  assert.deepEqual(baseline.manifest.dependencies, candidate.manifest.dependencies);
  assert.deepEqual(baseline.manifest.optionalDependencies, candidate.manifest.optionalDependencies);
  const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: options.sourceRoot,
    encoding: "utf8",
  }).trim();
  const workloadSha256 = createHash("sha256")
    .update(await fs.readFile(new URL(import.meta.url)))
    .digest("hex");
  const fixtures = path.join(root, "fixtures");
  await fs.mkdir(fixtures);
  const plugins = await makePlugins(fixtures);
  await fs.writeFile(
    path.join(root, "inputs.json"),
    JSON.stringify(
      {
        options,
        sourceHead,
        workloadSha256,
        driver,
        baseline,
        candidate,
        plugins,
        node: process.version,
        host: await resources(),
        delayMs,
        pluginFiles: 512,
        ordinaryFiles: 4096,
        sqliteMiB: 192,
        order: "ABAB",
        acceptance:
          "4 GETs each; candidate 0 after stop; identical output; median downtime saves >=8400ms; total median/p95 do not regress; any >=20% regression stops acceptance",
      },
      null,
      2,
    ),
  );
  const rows: Row[] = [];
  try {
    for (let sample = 0; sample < options.samples; sample++) {
      for (const [label, target] of [
        ["baseline", baseline],
        ["candidate", candidate],
      ] as const) {
        const row = await runSample(
          path.join(root, label + "-" + sample),
          label,
          sample,
          driver,
          target,
          plugins,
        );
        rows.push(row);
        await fs.writeFile(path.join(root, "samples.json"), JSON.stringify(rows, null, 2));
        console.log(
          JSON.stringify({
            label,
            sample,
            totalMs: row.totalMs,
            downtimeMs: row.downtimeMs,
            selectedGets: row.selectedGets,
            getsAfterStop: row.getsAfterStop,
            runId: row.runId,
          }),
        );
      }
    }
    const summary = Object.fromEntries(
      ["baseline", "candidate"].map((label) => [
        label,
        Object.fromEntries(
          (["totalMs", "downtimeMs", "observedMs"] as const).map((metric) => {
            const values = rows
              .filter((row) => row.label === label)
              .map((row) => row[metric])
              .toSorted((a, b) => a - b);
            return [
              metric,
              {
                median: values[Math.floor(values.length / 2)],
                p95: values[Math.ceil(values.length * 0.95) - 1],
                min: values[0],
                max: values.at(-1),
              },
            ];
          }),
        ),
      ]),
    );
    const paired = Array.from({ length: options.samples }, (_, sample) => ({
      sample,
      totalDeltaMs: rows[2 * sample + 1]!.totalMs - rows[2 * sample]!.totalMs,
      downtimeDeltaMs: rows[2 * sample + 1]!.downtimeMs - rows[2 * sample]!.downtimeMs,
    }));
    const before = summary.baseline!,
      after = summary.candidate!;
    const totalMedianRegression = after.totalMs!.median! / before.totalMs!.median! - 1;
    const totalP95Regression = after.totalMs!.p95! / before.totalMs!.p95! - 1;
    const downtimeSavedMs = before.downtimeMs!.median! - after.downtimeMs!.median!;
    const acceptance = {
      downtimeSavedMs,
      totalMedianRegression,
      totalP95Regression,
      passed: downtimeSavedMs >= 8400 && totalMedianRegression <= 0 && totalP95Regression <= 0,
      stopForRegression:
        totalMedianRegression >= 0.2 ||
        totalP95Regression >= 0.2 ||
        after.downtimeMs!.median! >= before.downtimeMs!.median! * 1.2,
    };
    for (const input of [driver, baseline, candidate]) {
      assert.equal(
        (await archive(input.file)).sha256,
        input.sha256,
        "Artifact changed during measurement",
      );
    }
    assert.equal(
      createHash("sha256")
        .update(await fs.readFile(new URL(import.meta.url)))
        .digest("hex"),
      workloadSha256,
    );
    await fs.writeFile(
      path.join(root, "summary.json"),
      JSON.stringify(
        {
          summary,
          paired,
          acceptance,
          probeIntervalMs: 200,
          probeTimeoutMs: 500,
          cgroupScope:
            "visible container counters; may include unrelated work; harness resource counters are not all descendants",
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ summary, paired, acceptance }));
    assert.ok(
      acceptance.passed,
      "Timing acceptance not met; complete measurements are retained in summary.json",
    );
  } catch (error) {
    await fs.writeFile(path.join(root, "failure.txt"), String(error));
    throw error;
  }
}
