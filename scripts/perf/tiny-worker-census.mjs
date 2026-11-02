// Idle worker census on an already-built, isolated Gateway; never connects to an existing server.
// node --import ./scripts/tsx.mjs scripts/perf/tiny-worker-census.mjs --output <new-directory>
// Reports process RSS (not per-isolate RSS), worker heaps/spaces and missing diagnostic coverage.
// Compare separate built revisions. This is a cold/idle census, not a load-test latency gate.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { readGatewayResources } from "../lib/gateway-bench-profile.ts";
import { buildGatewayBenchChildArgs, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({ options: { output: { type: "string" } } });
assert(values.output, "--output must name a new owned directory");
const root = path.resolve(values.output);
assert(!fs.existsSync(root), "Refusing to reuse an existing directory");
fs.mkdirSync(root, { recursive: true });
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(root, "tmp"));
const workerSamples = path.join(root, "workers");
fs.mkdirSync(workerSamples);
fs.writeFileSync(
  path.join(workspace, "avatar.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
fs.writeFileSync(path.join(workspace, "IDENTITY.md"), "# Identity\n- Name: Synthetic census\n");
const configPath = path.join(root, "openclaw.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    gateway: { mode: "local", auth: { mode: "none" } },
    plugins: { enabled: false },
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: {
        main: { workspace, identity: { name: "Synthetic census", avatar: "avatar.png" } },
      },
    },
  }),
);
let port;
do {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  port = listener.address().port;
  await new Promise((resolve) => {
    listener.close(resolve);
  });
} while (port < 40000);
const log = fs.openSync(path.join(root, "gateway.log"), "w");
const started = performance.now();
const child = spawn(
  process.execPath,
  buildGatewayBenchChildArgs("dist/entry.js", port, [
    "--import",
    "./scripts/perf/team-shape-stress-loader.mjs",
    "--import",
    "./scripts/lib/gateway-bench-profile-preload.ts",
    "--import",
    "./scripts/perf/worker-retained-heap-preload.ts",
  ]),
  {
    env: createGatewayBenchEnv(root, configPath, {
      startupTrace: false,
      caseEnv: {
        TMPDIR: path.join(root, "tmp"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BENCH_RETAINED_WORKER_DIR: workerSamples,
      },
    }),
    stdio: ["ignore", log, log, "ipc"],
  },
);
const exited = once(child, "exit");
try {
  const deadline = Date.now() + 180_000;
  for (;;) {
    assert(child.exitCode === null && child.signalCode === null, "Gateway exited during startup");
    assert(Date.now() < deadline, "Gateway readiness timed out");
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`).catch(() => undefined);
    if (ready?.ok) {
      break;
    }
    await delay(250);
  }
  const startupMs = performance.now() - started;
  const beforeAvatar = await readGatewayResources(child, { includeWorkers: true });
  const requestStarted = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/avatar/main?meta=1`);
  const body = await response.json();
  assert(response.ok, JSON.stringify(body));
  assert(body.avatarUrl, JSON.stringify(body));
  const image = await fetch(new URL(body.avatarUrl, `http://127.0.0.1:${port}`));
  assert(image.ok && image.headers.get("content-type")?.startsWith("image/"));
  assert((await image.arrayBuffer()).byteLength > 0);
  const firstAvatarMs = performance.now() - requestStarted;
  await readGatewayResources(child, { includeWorkers: true });
  await delay(1000);
  const afterAvatar = await readGatewayResources(child, { includeWorkers: true });
  const workers = [];
  for (const name of fs.readdirSync(workerSamples).filter((file) => file.endsWith(".ready.json"))) {
    const { commandPath } = JSON.parse(fs.readFileSync(path.join(workerSamples, name), "utf8"));
    fs.writeFileSync(`${commandPath}.tmp`, JSON.stringify({ id: "idle", operation: "collect" }));
    fs.renameSync(`${commandPath}.tmp`, commandPath);
    const reply = commandPath.replace(".command.json", ".idle.json");
    const sampleDeadline = Date.now() + 30_000;
    while (!fs.existsSync(reply) && Date.now() < sampleDeadline) {
      await delay(100);
    }
    workers.push(
      fs.existsSync(reply)
        ? JSON.parse(fs.readFileSync(reply, "utf8"))
        : { worker: name, missing: true },
    );
  }
  const report = {
    startupMs,
    firstAvatarMs,
    hostLoad: os.loadavg(),
    beforeAvatar,
    afterAvatar,
    workers,
  };
  fs.writeFileSync(path.join(root, "census.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    await exited;
  } finally {
    clearTimeout(kill);
    fs.closeSync(log);
  }
}
