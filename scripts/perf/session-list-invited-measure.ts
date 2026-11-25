// Measure the sessions.list projection owner on 15,000 persisted rows, with no network or model I/O.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-list-invited-measure.ts \
//   --state-dir <fresh-directory> [--source-ref <baseline>] [--calls 50] [--interval-ms 600]
// Run serial A/A/B arms and reverse order between rounds. Require matching response digests,
// bounded membership lookups, and lower invited CPU beyond A/A spread with stable sibling metrics.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import type { SessionListDiagnostics } from "../../src/gateway/session-list-diagnostics.types.js";
import { createGatewayBenchEnv, summarizeNumbers } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "source-ref": { type: "string" },
    calls: { type: "string", default: "50" },
    "interval-ms": { type: "string", default: "600" },
    capture: { type: "boolean", default: false },
  },
});
assert(values["state-dir"]);
assert(global.gc, "Run with --expose-gc");
const calls = parseStrictIntegerOption({
  raw: values.calls,
  label: "--calls",
  min: 4,
  fallback: 50,
});
const interval = parseStrictIntegerOption({
  raw: values["interval-ms"],
  label: "--interval-ms",
  min: 0,
  fallback: 600,
});
const root = path.resolve(values["state-dir"]);
const configPath = path.join(root, "openclaw.json");
mkdirSync(root);
for (const directory of ["home", "tmp"]) {
  mkdirSync(path.join(root, directory));
}
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
};
const sourceRef = values["source-ref"];
if (sourceRef) {
  const sources = new Map<string, string>(
    [
      "session-list-view-cache",
      "session-membership-projection",
      "session-row-membership-read",
      "session-row-presentation",
      "session-row-publication",
      "session-row-selection",
      "session-utils-list",
    ].map((name) => {
      const file = `src/gateway/${name}.ts`;
      const url = new URL(`../../${file}`, import.meta.url);
      return [
        url.href,
        sourceRef === "working-tree"
          ? readFileSync(url, "utf8")
          : execFileSync("git", ["show", `${sourceRef}:${file}`], { encoding: "utf8" }),
      ];
    }),
  );
  registerHooks({
    load(url, context, nextLoad) {
      const source = sources.get(url);
      return source === undefined
        ? nextLoad(url, context)
        : { format: "module-typescript", source, shortCircuit: true };
    },
  });
}

const scopes: ("operator.read" | "operator.write")[] = ["operator.read", "operator.write"];
const agents = ["main", "reviewer", "planner", "builder", "tester", "writer"];
const cfg: OpenClawConfig = {
  agents: { ownership: "explicit", entries: Object.fromEntries(agents.map((id) => [id, {}])) },
  plugins: { enabled: false },
  gateway: {
    roles: {
      default: "guest",
      definitions: {
        guest: { agents: "*", scopes, sessions: { others: "invited" } },
        teammate: { agents: "*", scopes, sessions: { others: "view" } },
      },
    },
  },
};
writeFileSync(configPath, JSON.stringify(cfg));
const [
  { setRuntimeConfigSnapshot },
  agentDb,
  stateDb,
  { writeSessionEntry },
  sharing,
  { ensureProfileForEmail },
  { setDisplayName, setUserProfileRole },
  { prepareUserProfileCatalog },
  { prepareGatewayRecipientProfile },
  { createSessionRowProjection },
  { listProjectedSessions },
  { retainSessionListForegroundWork },
  { createEmptyPluginRegistry },
  { setActivePluginRegistry },
] = await Promise.all([
  import("../../src/config/runtime-snapshot.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/config/sessions/session-sharing-store.js"),
  import("../../src/state/user-profiles.js"),
  import("../../src/state/user-profile-writes.worker.js"),
  import("../../src/state/user-profile-list.js"),
  import("../../src/gateway/expected-profile.js"),
  import("../../src/gateway/session-row-projection.js"),
  import("../../src/gateway/session-utils-list.js"),
  import("../../src/gateway/session-projection-work.js"),
  import("../../src/plugins/registry-empty.js"),
  import("../../src/plugins/runtime.js"),
]);
setActivePluginRegistry(createEmptyPluginRegistry());
setRuntimeConfigSnapshot(cfg, cfg);
const labels = ["invited", "uninvited", "shared-view", "admin"];
const ids = labels.map((label) => {
  const { id } = ensureProfileForEmail(`${label}@synthetic.example`);
  setDisplayName(id, label);
  return id;
});
setUserProfileRole(ids[2]!, "teammate");
await prepareUserProfileCatalog();
const clients = ids.map((profileId, i): GatewayClient => {
  const client: GatewayClient = {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: i === 3 ? ["operator.admin", ...scopes] : scopes,
      client: { id: "openclaw-control-ui", version: "bench", platform: "node", mode: "webchat" },
    },
    authenticatedUserProfile: {
      profileId,
      displayName: labels[i]!,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
  prepareGatewayRecipientProfile(client);
  return client;
});
const key = (agent: string, index: number) => `agent:${agent}:dashboard:fixture-${index}`;
const anchor = 1_800_000_000_000;
for (const [agentIndex, agentId] of agents.entries()) {
  agentDb.runOpenClawAgentWriteTransaction(
    (database) => {
      for (let index = 0; index < 2500; index++) {
        const sessionKey = key(agentId, index);
        const creator = index % 13 === 0 ? ids[1]! : index % 17 === 0 ? ids[0]! : ids[2]!;
        writeSessionEntry(database, sessionKey, {
          sessionId: `${agentId}-${index}`,
          label: `Synthetic dashboard ${index}`,
          updatedAt: anchor - (index * agents.length + agentIndex) * 1000,
          createdActor: { type: "human", source: "profile", id: creator },
          visibility: index % 11 === 0 ? "draft" : "shared",
          ...(index % 5 === 0 ? { archivedAt: anchor } : {}),
        });
      }
    },
    { agentId },
  );
  for (let index = 19; index < 300; index += 19) {
    await sharing.addSessionMember(
      { agentId, sessionKey: key(agentId, index) },
      { identityId: ids[0]!, addedBy: ids[2]!, addedAt: anchor },
    );
  }
}

const release = retainSessionListForegroundWork();
const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
try {
  await projection.ensureMaterialized();
  const digest = createHash("sha256");
  let checks = 0;
  const hasMembership = projection.hasMembership;
  projection.hasMembership = (...args) => {
    checks++;
    return hasMembership(...args);
  };
  let prepareCpuUs = 0;
  const diagnostics: SessionListDiagnostics = {
    mark() {},
    startSyncCpu: () => process.threadCpuUsage(),
    finishSyncCpu(metric, start) {
      if (metric === "prepareThreadCpuMs" && start) {
        const used = process.threadCpuUsage(start);
        prepareCpuUs += used.user + used.system;
      }
    },
    projection: {
      prepareSyncMs: 0,
      rowSyncMs: 0,
      yieldWaitMs: 0,
      yieldCount: 0,
      selectedRowCount: 0,
      dirtyRowCount: 0,
      materializedRowCount: 0,
      reusedRowCount: 0,
    },
  };
  const read = (index: number) =>
    listProjectedSessions({
      projection,
      client: clients[index % clients.length],
      acceptsSerializedJson: true,
      diagnostics,
      opts: {
        rowMode: "compact",
        limit: 100,
        offset: (Math.floor(index / clients.length) % 2) * 100,
      },
    });
  for (let i = 0; i < 24; i++) {
    await read(i);
  }
  global.gc();
  const started = performance.now();
  const hostLoad = loadavg();
  const samples = [];
  const target = { agentId: "reviewer", sessionKey: key("reviewer", 1) };
  for (let index = 0; index < calls; index++) {
    const wait = started + index * interval - performance.now();
    if (wait > 0) {
      await delay(wait);
    }
    const change = index > 0 && index % 12 === 0;
    if (change) {
      if (index % 24 === 12) {
        assert(
          (
            await sharing.addSessionMember(target, {
              identityId: ids[0]!,
              addedBy: ids[2]!,
              addedAt: anchor,
            })
          ).inserted,
        );
      } else {
        assert(await sharing.removeSessionMember(target, ids[0]!));
      }
    }
    checks = 0;
    prepareCpuUs = 0;
    const allocated = getHeapStatistics().total_allocated_bytes;
    const beforeCpu = process.threadCpuUsage();
    const before = performance.now();
    const result = await read(index);
    const ms = performance.now() - before;
    const cpu = process.threadCpuUsage(beforeCpu);
    const bytes = getHeapStatistics().total_allocated_bytes - allocated;
    assert.equal(result.count, 100);
    assert.equal(result.nextOffset, ((Math.floor(index / clients.length) % 2) + 1) * 100);
    assert(bytes > 0, "Node must report cumulative V8 allocation");
    samples.push({
      viewer: labels[index % labels.length]!,
      change,
      ms,
      cpuUs: cpu.user + cpu.system,
      prepareCpuUs,
      bytes,
      checks,
    });
    const { ts: _ts, rowsRevision: _rev, ...stable } = result;
    let json = JSON.stringify(stable);
    ids.forEach((id, i) => {
      json = json.replaceAll(id, labels[i]!);
    });
    json = json.replaceAll(root, "<synthetic-state>");
    // Fixture creation assigns new profile versions and row snapshot times in each arm.
    json = json
      .replace(/"snapshotAt":\d+/g, '"snapshotAt":0')
      .replace(/(\/api\/users\/[^"]+\/avatar\?v=)\d+/g, (_, prefix: string) => `${prefix}0`);
    digest.update(json);
    if (values.capture) {
      appendFileSync(path.join(root, "responses.jsonl"), `${json}\n`);
    }
  }
  const result = {
    calls,
    interval,
    digest: digest.digest("hex"),
    hostLoad,
    sourceRef: sourceRef ?? "working-tree",
    measuredMs: performance.now() - started,
    latencyMs: summarizeNumbers(samples.map((sample) => sample.ms)),
    samples,
  };
  writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, samples: undefined }));
} finally {
  projection.dispose();
  release();
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
}
