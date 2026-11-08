// Offline storage admission benchmark; run only on the authorized benchmark host.
import { createCipheriv, createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const MiB = 1024 * 1024;
const marker = "openclaw-seal-version-fixture-v1\n";
const agentId = "seal-version-bench";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "state-dir": { type: "string" },
    mib: { type: "string" },
    "expect-version": { type: "string" },
    "expect-full-scans": { type: "string" },
    "start-at": { type: "string" },
    "refresh-proof": { type: "boolean" },
    help: { type: "boolean" },
  },
});

if (values.help) {
  console.log(`Usage: node --import ./scripts/tsx.mjs scripts/perf/seal-version-restart.ts <seed|open>
  --state-dir <directory>       Required; seed creates it exclusively.
  --mib 2048                    Seed payload size; minimum 2048 MiB.
  --expect-version <version>    Require the actual package/artifact version.
  --refresh-proof              Open after invalidating this fixture's old seal.
  --expect-full-scans <0|1>     Reject an unexpected agent integrity-scan count.
  --start-at <epoch-ms>         Synchronize cold opens after module/runtime preparation.
Seed writes sequential 2 MiB transactions with pacing and Linux Dirty checks.
After seed, use open --refresh-proof in a fresh process to establish full proof.
OPENCLAW_VERSION does not override the package version used by old seal policies.`);
} else {
  await main();
}

async function main() {
  const command = positionals[0];
  if (positionals.length !== 1 || (command !== "seed" && command !== "open")) {
    throw new Error("Choose exactly one command: seed or open");
  }
  if (!values["state-dir"]) {
    throw new Error("--state-dir is required");
  }
  const stateDir = path.resolve(values["state-dir"]);
  const markerPath = path.join(stateDir, ".seal-version-fixture");
  const mib = parseStrictIntegerOption({
    raw: values.mib,
    label: "--mib",
    fallback: 2048,
    min: 2048,
  });
  const startAt = parseStrictIntegerOption({
    raw: values["start-at"],
    label: "--start-at",
    fallback: 0,
    min: 1,
  });
  const expectedScans = values["expect-full-scans"];
  if (expectedScans !== undefined && expectedScans !== "0" && expectedScans !== "1") {
    throw new Error("--expect-full-scans must be 0 or 1");
  }
  if (command === "seed") {
    mkdirSync(path.dirname(stateDir), { recursive: true });
    mkdirSync(stateDir, { mode: 0o700 });
    for (const directory of ["home", "tmp"]) {
      mkdirSync(path.join(stateDir, directory));
    }
  } else if (!lstatSync(stateDir).isDirectory() || readFileSync(markerPath, "utf8") !== marker) {
    throw new Error("open requires a completed synthetic seal-version fixture");
  }
  const configPath = path.join(stateDir, "openclaw.json");
  process.env = {
    ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
    OPENCLAW_STATE_DIR: stateDir,
    TMPDIR: path.join(stateDir, "tmp"),
    TMP: path.join(stateDir, "tmp"),
    TEMP: path.join(stateDir, "tmp"),
  };
  if (command === "seed") {
    writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
  }

  // Environment must be isolated before loading the real storage owners.
  const { VERSION } = await import("../../src/version.js");
  if (values["expect-version"] !== undefined && VERSION !== values["expect-version"]) {
    throw new Error(`Expected app version ${values["expect-version"]}; loaded ${VERSION}`);
  }
  const { applyLoggingConfig } = await import("../../src/logging/logger.js");
  applyLoggingConfig({
    level: "info",
    consoleLevel: "silent",
    file: path.join(stateDir, "bench.log"),
  });
  const agent = await import("../../src/state/openclaw-agent-db.js");
  const state = await import("../../src/state/openclaw-state-db.js");
  const admission = await import("../../src/infra/sqlite-database-admission.js");
  const { requireNodeSqlite } = await import("../../src/infra/node-sqlite.js");
  const diagnostics = await import("../../src/infra/diagnostic-events.js");
  requireNodeSqlite();
  const options = { agentId };
  const databasePath = agent.resolveOpenClawAgentSqlitePath(options);
  let maxDirtyBytes = 0;
  async function paceWrites() {
    if (process.platform !== "linux") {
      throw new Error("Fixture generation requires Linux /proc/meminfo Dirty accounting");
    }
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const match = /^Dirty:\s+(\d+)\s+kB$/mu.exec(readFileSync("/proc/meminfo", "utf8"));
      if (!match) {
        throw new Error("Cannot read Linux Dirty memory");
      }
      const dirty = Number(match[1]) * 1024;
      maxDirtyBytes = Math.max(maxDirtyBytes, dirty);
      if (dirty >= 2048 * MiB) {
        throw new Error(`Dirty memory reached the 2 GiB safety limit: ${dirty}`);
      }
      if (dirty < 1024 * MiB) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error("Dirty memory stayed above 1 GiB for ten minutes; stopped seeding");
      }
      await delay(1000);
    }
  }
  let result: Record<string, unknown>;
  try {
    if (command === "seed") {
      await paceWrites();
      const database = agent.openOpenClawAgentDatabase(options);
      const cipher = createCipheriv(
        "aes-256-ctr",
        createHash("sha256").update(marker).digest(),
        Buffer.alloc(16),
      );
      const zeros = Buffer.alloc(48 * 1024);
      const rows = mib * 16;
      const started = performance.now();
      for (let first = 0; first < rows; first += 32) {
        await paceWrites();
        // Offline fixture primitive, inside the real owner's transaction and write invalidation.
        agent.runOpenClawAgentWriteTransaction(({ db }) => {
          const insert = db.prepare(
            "INSERT INTO cache_entries(scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
          );
          for (let row = first; row < Math.min(rows, first + 32); row++) {
            insert.run(
              "seal-version-bench",
              String(row),
              JSON.stringify({ value: cipher.update(zeros).toString("base64") }),
              1,
            );
          }
        }, options);
        if (first % 256 === 0) {
          database.walMaintenance.checkpoint();
        }
        await delay(100);
        await paceWrites();
        if ((first + 32) % 1024 === 0) {
          console.error(JSON.stringify({ seededMiB: (first + 32) / 16, maxDirtyBytes }));
        }
      }
      result = { rows, payloadMiB: mib, seedMs: performance.now() - started, maxDirtyBytes };
    } else {
      if (statSync(databasePath).size < 2048 * MiB) {
        throw new Error("Measurement requires an agent database of at least 2 GiB");
      }
      if (values["refresh-proof"]) {
        admission.revokeSqliteDatabaseAdmissionsForPath(databasePath);
      }
      const gates: Array<Record<string, string | number | boolean>> = [];
      const unsubscribe = diagnostics.onInternalDiagnosticEvent(
        (event) => {
          if (
            event.type === "log.record" &&
            event.message === "agent database integrity gate" &&
            event.attributes?.agentId === agentId
          ) {
            gates.push(event.attributes);
          }
        },
        { include: ["log.record"] },
      );
      try {
        if (startAt) {
          const waitMs = startAt - Date.now();
          if (waitMs <= 0) {
            throw new Error("--start-at elapsed before the runtime was prepared");
          }
          await delay(waitMs);
        }
        const startedAt = Date.now();
        const started = performance.now();
        const sealMatched = admission.readSqliteDatabaseCleanClose(databasePath);
        const sealLookupMs = performance.now() - started;
        agent.openOpenClawAgentDatabase(options);
        const openMs = performance.now() - started;
        await diagnostics.waitForDiagnosticEventsDrained();
        const fullScans = gates.filter((gate) => gate.integrityGateMode === "full").length;
        if (!sealMatched && fullScans !== 1) {
          throw new Error(`No matching seal, but observed ${fullScans} full integrity gates`);
        }
        if (expectedScans !== undefined && fullScans !== Number(expectedScans)) {
          throw new Error(`Expected ${expectedScans} full scans; observed ${fullScans}`);
        }
        result = {
          startedAt,
          sealMatched,
          sealLookupMs,
          openMs,
          fullScans,
          integrityGateMode: fullScans > 0 ? "full" : "seal-reuse",
          integrityGateMs: gates.reduce((sum, gate) => sum + Number(gate.integrityGateMs ?? 0), 0),
          gates,
        };
      } finally {
        unsubscribe();
      }
    }
  } finally {
    await agent.closeOpenClawAgentDatabasesAsync();
    await state.closeOpenClawStateDatabaseAsync();
  }
  if (command === "seed") {
    // Require a fresh process to verify the newly populated bytes before measuring reuse.
    admission.invalidateSqliteDatabaseCleanClose(databasePath);
    writeFileSync(markerPath, marker);
  }
  console.log(
    JSON.stringify({
      command,
      appVersion: VERSION,
      node: process.version,
      databasePath,
      databaseBytes: statSync(databasePath).size,
      ...result,
    }),
  );
}
