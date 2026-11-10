// Offline synthetic input for idle-gateway-measure.ts; never accepts existing state.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { runManagedCommand } from "../lib/managed-child-process.mts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    port: { type: "string", default: "41583" },
  },
});
if (!values["state-dir"]) {
  throw new Error("--state-dir must name a fresh synthetic fixture directory");
}
const stateDir = path.resolve(values["state-dir"]);
const generated = await runManagedCommand({
  bin: process.execPath,
  args: [
    "--import",
    "./scripts/tsx.mjs",
    "scripts/perf/team-shape-fixture.ts",
    "--state-dir",
    stateDir,
    "--port",
    values.port,
    "--sessions",
    "3",
    "--runs",
    "0",
    "--approvals",
    "0",
    "--cron",
    "0",
    "--projects",
    "0",
    "--transcript-mib",
    "0",
  ],
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
if (generated !== 0) {
  throw new Error("Synthetic team fixture failed");
}
const configPath = path.join(stateDir, "openclaw.json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as OpenClawConfig;
config.agents = {
  ...config.agents,
  ownership: "explicit",
  defaults: { systemAgent: { agentId: "main" } },
  entries: {
    ...config.agents?.entries,
    peer: { workspace: path.join(stateDir, "workspace-peer") },
    removed: { workspace: path.join(stateDir, "workspace-removed") },
  },
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: stateDir,
  NODE_DISABLE_COMPILE_CACHE: "1",
  TMPDIR: process.env.TMPDIR ?? path.join(stateDir, "tmp"),
};
const [{ createDefaultProactiveJob }, receipts, store, state] = await Promise.all([
  import("../../src/cron/default-proactive-job.js"),
  import("../../src/cron/proactive-job-receipt.kernel.js"),
  import("../../src/cron/store.js"),
  import("../../src/state/openclaw-state-db.js"),
]);
const storePath = path.join(stateDir, "cron", "jobs.json");
const primary = { ...createDefaultProactiveJob(config, "main", 1), enabled: false };
const peer = { ...createDefaultProactiveJob(config, "peer", 1), enabled: false };
const converted = { ...primary, id: "synthetic-converted", name: "Synthetic converted" };
const ordinary = { ...primary, id: "synthetic-ordinary", name: "Synthetic ordinary" };
try {
  await store.saveCronJobsStore(storePath, {
    version: 1,
    jobs: [primary, peer, converted, ordinary],
  });
  state.runOpenClawStateWriteTransaction(({ db }) => {
    receipts.recordDefaultProactiveJobInDatabase(db, storePath, "main", primary.id, 1);
    receipts.recordConvertedProactiveJobInDatabase(db, storePath, "main", converted.id);
    receipts.recordDefaultProactiveJobInDatabase(db, storePath, "peer", peer.id, 1);
    receipts.recordDefaultProactiveJobInDatabase(db, storePath, "removed", "absent-job", 1);
  });
} finally {
  await state.closeOpenClawStateDatabaseAsync();
}
console.log(JSON.stringify({ fixture: "health-cron", sessions: 3, agents: 3, jobs: 4 }));
