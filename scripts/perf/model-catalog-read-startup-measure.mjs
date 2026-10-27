// Measure an already-built worker, without a TypeScript loader:
// node scripts/perf/model-catalog-read-startup-measure.mjs --entry <worker.js> \
//   --fixture disk-budget|attachment|catalog --samples 5 --warm-samples 1000 --graph --output <json>
// Fixtures are created under .local and removed afterward. Optional --input <json>
// supplies an existing synthetic input instead (catalog expects 40 rows).
// Omitting --fixture/--input preserves import-only measurements. Alternate base/candidate
// runs; CPU/allocation cover import + first task, then warm tasks separately. RSS is the
// whole-process delta, not worker-exclusive memory. --graph adds a separate fresh worker
// after timing samples: inspector enumerates parsed file scripts after its first result.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { deserialize, getHeapStatistics } from "node:v8";
import { isMainThread, MessageChannel, Worker, workerData } from "node:worker_threads";

function counters() {
  const heap = getHeapStatistics();
  assert(Number.isFinite(heap.total_allocated_bytes), "Node 26.12+ allocation counter required");
  return { heap, cpu: process.threadCpuUsage(), time: performance.now() };
}

function delta(before) {
  const after = counters();
  return {
    elapsedMs: after.time - before.time,
    cpuMs: (after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000,
    allocatedBytes: after.heap.total_allocated_bytes - before.heap.total_allocated_bytes,
    heapUsedBytes: after.heap.used_heap_size,
  };
}

async function parsedGraph() {
  const { Session } = await import("node:inspector/promises");
  const session = new Session();
  const scripts = new Map();
  session.connect();
  session.on("Debugger.scriptParsed", ({ params }) => {
    if (params.url.startsWith("file:") && params.url !== import.meta.url) {
      scripts.set(params.url, params.scriptId);
    }
  });
  try {
    await session.post("Debugger.enable");
    const modules = [];
    for (const [url, scriptId] of scripts) {
      const { scriptSource } = await session.post("Debugger.getScriptSource", { scriptId });
      modules.push({ url, sourceBytes: Buffer.byteLength(scriptSource) });
    }
    return {
      moduleCount: modules.length,
      sourceBytes: modules.reduce((sum, entry) => sum + entry.sourceBytes, 0),
      modules: modules.toSorted((a, b) => a.url.localeCompare(b.url)),
    };
  } finally {
    session.disconnect();
  }
}

function runTask(port, input, taskId) {
  return new Promise((resolve, reject) => {
    let catalogs;
    let chunks = [];
    const receive = (message) => {
      if (message.taskId !== taskId) {
        return;
      }
      if (message.status === "request") {
        for (const frame of message.value.frames) {
          if (!frame.done) {
            chunks.push(Buffer.from(frame.bytes));
            if (frame.recordDone) {
              catalogs = deserialize(Buffer.concat(chunks));
              chunks = [];
            }
          }
        }
        port.postMessage({ taskId, responseId: message.id, input: null });
      } else if (message.status === "ok" || message.status === "failed") {
        port.off("message", receive);
        if (message.status === "failed" || message.value?.error) {
          reject(new Error(message.error ?? message.value.error));
        } else {
          resolve(catalogs ?? message.value);
        }
      }
    };
    port.on("message", receive);
    port.postMessage({
      taskId,
      input,
      interactive: true,
      nativeSections: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      taskContext: { deletedAgentDatabaseFences: [] },
    });
  });
}

function resultSummary(value, fixture) {
  if (fixture === "disk-budget") {
    assert.deepEqual(value, { databaseWalBytes: 0, totalBytes: 64 * 4096 });
  } else if (fixture === "attachment") {
    assert.equal(value.sizeBytes, 256 * 1024);
    assert.equal(value.mime, "text/plain");
    assert.equal(value.buffer.byteLength, 256 * 1024);
  } else if (fixture === "catalog") {
    assert(Array.isArray(value), "Catalog transfer did not return its rows");
    assert.equal(value.length, 40, "Catalog fixture must contain 40 catalogs");
  }
  return Array.isArray(value)
    ? {
        rows: value.length,
        contentsBytes: value.reduce((n, row) => n + Buffer.byteLength(row.contents), 0),
      }
    : value?.buffer
      ? { sizeBytes: value.sizeBytes, mime: value.mime, bufferBytes: value.buffer.byteLength }
      : value;
}

async function sample(entry, input, warmSamples, fixture, graphOnly = false) {
  const control = new MessageChannel();
  const tasks = new MessageChannel();
  const hostLoadBefore = loadavg();
  const rssBefore = process.memoryUsage.rss();
  const started = performance.now();
  const worker = new Worker(new URL(import.meta.url), {
    execArgv: [],
    workerData: { entry, pluginCatalogRead: true, control: control.port2 },
    transferList: [control.port2],
  });
  const failure = new Promise((_, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`Worker exited before measurement: ${code}`)));
  });
  const timeout = setTimeout(() => {
    void worker.terminate();
  }, 120_000);
  const wait = (promise) => Promise.race([promise, failure]);
  const command = async (operation) => {
    const response = once(control.port1, "message");
    control.port1.postMessage(operation);
    return (await wait(response))[0];
  };
  try {
    await wait(once(control.port1, "message"));
    let result;
    if (input !== undefined) {
      const ready = once(tasks.port1, "message");
      worker.postMessage({ type: "openclaw.worker-task-port", port: tasks.port2 }, [tasks.port2]);
      assert.equal((await wait(ready))[0].status, "ready");
      result = resultSummary(await wait(runTask(tasks.port1, input, 1)), fixture);
    }
    const spawnToFirstResultMs = performance.now() - started;
    const rssDeltaBytes = process.memoryUsage.rss() - rssBefore;
    if (graphOnly) {
      return { ...(await command("graph")), result };
    }
    const cold = await command("measure");
    let warm;
    if (input !== undefined && warmSamples > 0) {
      await command("start");
      for (let index = 0; index < warmSamples; index++) {
        resultSummary(await wait(runTask(tasks.port1, input, index + 2)), fixture);
      }
      warm = { ...(await command("measure")), iterations: warmSamples };
    }
    return {
      ...cold,
      spawnToFirstResultMs,
      ...(input === undefined
        ? { importMs: cold.elapsedMs, spawnToImportedMs: spawnToFirstResultMs }
        : {}),
      rssDeltaBytes,
      result,
      warm,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
    };
  } finally {
    clearTimeout(timeout);
    await worker.terminate();
    control.port1.close();
    tasks.port1.close();
    tasks.port2.close();
  }
}

if (isMainThread) {
  const { values } = parseArgs({
    options: {
      entry: { type: "string", default: "dist/agents/plugin-model-catalog-read.worker.js" },
      samples: { type: "string", default: "10" },
      "warm-samples": { type: "string", default: "1000" },
      fixture: { type: "string" },
      input: { type: "string" },
      graph: { type: "boolean", default: false },
      "max-modules": { type: "string" },
      output: { type: "string" },
    },
  });
  const count = Number(values.samples);
  const warmSamples = Number(values["warm-samples"]);
  assert(Number.isSafeInteger(count) && count > 0);
  assert(Number.isSafeInteger(warmSamples) && warmSamples >= 0);
  assert(values.output, "--output is required");
  if (values["max-modules"] !== undefined) {
    assert(values.graph, "--max-modules requires --graph");
    assert(
      Number.isSafeInteger(Number(values["max-modules"])) && Number(values["max-modules"]) > 0,
    );
  }
  assert(!values.fixture || ["disk-budget", "attachment", "catalog"].includes(values.fixture));
  const entry = pathToFileURL(path.resolve(values.entry)).href;
  let input = values.input ? JSON.parse(readFileSync(values.input, "utf8")) : undefined;
  let fixtureRoot;
  const report = { entry: values.entry, samples: [] };
  try {
    if (!values.input && (values.fixture === "disk-budget" || values.fixture === "catalog")) {
      mkdirSync(".local", { recursive: true });
      fixtureRoot = mkdtempSync(path.resolve(".local/worker-startup-"));
    }
    if (!values.input && values.fixture === "disk-budget") {
      const sessions = path.join(fixtureRoot, "agents/main/sessions");
      mkdirSync(sessions, { recursive: true });
      for (let index = 0; index < 64; index++) {
        writeFileSync(path.join(sessions, `fixture-${index}.jsonl`), Buffer.alloc(4096, "x"));
      }
      input = path.join(sessions, "sessions.json");
    } else if (!values.input && values.fixture === "attachment") {
      input = {
        base64: Buffer.alloc(256 * 1024, "x").toString("base64"),
        label: "fixture.txt",
        mime: "text/plain",
      };
    } else if (!values.input && values.fixture === "catalog") {
      const { DatabaseSync } = await import("node:sqlite");
      const databasePath = path.join(fixtureRoot, "agents/main/agent/openclaw-agent.sqlite");
      mkdirSync(path.dirname(databasePath), { recursive: true });
      const pkg = JSON.parse(readFileSync("package.json", "utf8"));
      const schemaVersion = pkg.openclaw.schemaVersions.agent;
      assert(Number.isSafeInteger(schemaVersion));
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(readFileSync("src/state/openclaw-agent-schema.sql", "utf8"));
        database.exec(`PRAGMA user_version=${schemaVersion}`);
        database
          .prepare(
            "INSERT OR REPLACE INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("primary", "agent", schemaVersion, "main", pkg.version, 1, 1);
        const insert = database.prepare(
          "INSERT OR REPLACE INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
        );
        for (let index = 0; index < 40; index++) {
          insert.run(
            "plugin-model-catalog-v1",
            `fixture-${index}`,
            JSON.stringify({
              generatedBy: "openclaw",
              providers: {
                fixture: { models: [{ id: `model-${index}`, name: `Model ${index}` }] },
              },
            }),
            1,
          );
        }
      } finally {
        database.close();
      }
      input = {
        agentId: "main",
        path: databasePath,
        env: { OPENCLAW_STATE_DIR: fixtureRoot },
        pluginIds: Array.from({ length: 40 }, (_, index) => `fixture-${index}`),
      };
    }
    for (let index = 0; index < count; index++) {
      const measured = await sample(entry, input, warmSamples, values.fixture);
      report.samples.push(measured);
      writeFileSync(values.output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(measured));
    }
    if (values.graph) {
      report.graph = await sample(entry, input, 0, values.fixture, true);
      writeFileSync(values.output, JSON.stringify(report, null, 2));
      console.log(
        JSON.stringify({
          moduleCount: report.graph.moduleCount,
          sourceBytes: report.graph.sourceBytes,
        }),
      );
      if (values["max-modules"] !== undefined) {
        assert(
          report.graph.moduleCount <= Number(values["max-modules"]),
          `Evaluated ${report.graph.moduleCount} modules; budget ${values["max-modules"]}`,
        );
      }
    }
  } finally {
    if (fixtureRoot) {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
} else {
  let before = counters();
  await import(workerData.entry);
  workerData.control.on("message", async (operation) => {
    if (operation === "start") {
      before = counters();
      workerData.control.postMessage(null, []);
    } else if (operation === "graph") {
      workerData.control.postMessage(await parsedGraph(), []);
    } else {
      workerData.control.postMessage(delta(before), []);
    }
  });
  workerData.control.postMessage({ imported: true }, []);
}
