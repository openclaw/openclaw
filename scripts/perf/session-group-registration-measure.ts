// Synthetic group registration, rename, and deletion through the real Gateway WebSocket transport.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    registrations: { type: "string", default: "20" },
    workload: { type: "string", default: "registration" },
    "warm-mutations": { type: "string", default: "5" },
  },
});
assert(values["state-dir"], "--state-dir must name a new synthetic directory");
const registrations = Number(values.registrations);
assert(Number.isSafeInteger(registrations) && registrations > 0);
const workload = values.workload;
assert(workload === "registration" || workload === "rename" || workload === "delete");
const warmMutations = Number(values["warm-mutations"]);
assert(Number.isSafeInteger(warmMutations) && warmMutations >= 5);
const directory = path.resolve(values["state-dir"]);
mkdirSync(directory);
for (const name of ["home", "workspace"]) {
  mkdirSync(path.join(directory, name));
}
const configPath = path.join(directory, "openclaw.json");
const port = await getFreePort();
const token = "synthetic-category-registration-token";
writeFileSync(
  configPath,
  JSON.stringify({
    ...BASE_GATEWAY_BENCH_CONFIG,
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      auth: { mode: "token", token },
      controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
    },
    agents: {
      defaults: { model: { primary: "synthetic/model" } },
      entries: { main: { workspace: path.join(directory, "workspace") } },
    },
    cron: { enabled: false },
  }),
);
process.env = createGatewayBenchEnv(path.join(directory, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: directory,
    OPENCLAW_SKIP_CHANNELS: "1",
    ...Object.fromEntries(
      [
        "SQLMEASURE_OUT",
        "SQLMEASURE_TEMP_ROOT",
        "TSX_DISABLE_CACHE",
        "NODE_OPTIONS",
        "NODE_DISABLE_COMPILE_CACHE",
        "TMPDIR",
        "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
        "OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT",
      ].flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
    ),
  },
});
const phase = (name: string) => {
  if (process.env.SQLMEASURE_OUT) {
    writeFileSync(path.join(process.env.SQLMEASURE_OUT, "phase"), name);
  }
};
phase("boot");
const { startGatewayServer } = await import("../../src/gateway/server.js");
const { GatewayClient } = await import("../../src/gateway/client.js");
const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
const ready = Promise.withResolvers<void>();
const peer = new GatewayClient({
  url: `ws://127.0.0.1:${port}`,
  token,
  origin: `http://127.0.0.1:${port}`,
  clientName: "openclaw-control-ui",
  mode: "webchat",
  platform: "web",
  instanceId: "synthetic-category-registration",
  scopes: ["operator.admin"],
  requestTimeoutMs: 60_000,
  onHelloOk: () => ready.resolve(),
  onConnectError: (error) => ready.reject(error),
});
const key = "agent:main:dashboard:category-registration";
const expected: Array<{ name: string; position: number }> = [];
const timings: Array<{ phase: string; ms: number }> = [];
async function assign(category: string, cold = false) {
  const label = cold ? "cold-new" : `warm-new-${expected.length}`;
  phase(label);
  const started = performance.now();
  const result = await peer.request<{ entry: { category: string } }>(
    cold ? "sessions.create" : "sessions.patch",
    {
      ...(cold ? { agentId: "main" } : {}),
      key,
      category,
    },
  );
  timings.push({ phase: label, ms: performance.now() - started });
  assert.equal(result.entry.category, category);
  expected.push({ name: category, position: expected.length });
  phase("readback");
  const listed = await peer.request<{ groups: Array<{ name: string; position: number }> }>(
    "sessions.groups.list",
    {},
  );
  assert.deepEqual(listed.groups, expected);
}
type GroupCatalog = {
  groups: Array<{ name: string; position: number }>;
  sectionOrder: string[];
};
type Member = { key: string; category?: string; updatedAt: number };

async function runMutations(action: "rename" | "delete") {
  phase(`setup-${action}`);
  const names = ["Unchanged", ...Array.from({ length: warmMutations + 1 }, (_, i) => `Group ${i}`)];
  const groups = names.map((name, position) => ({ name, position }));
  let sectionOrder = ["ungrouped", ...names.map((name) => `category:${name}`), "work"];
  const members: Member[] = [];
  async function describe(memberKey: string) {
    const { session } = await peer.request<{ session: Member | null }>("sessions.describe", {
      key: memberKey,
    });
    assert(session, `missing synthetic member ${memberKey}`);
    assert.equal(session.key, memberKey);
    assert(Number.isFinite(session.updatedAt));
    return session;
  }
  for (const [groupIndex, category] of names.entries()) {
    for (let memberIndex = 0; memberIndex < (groupIndex === 0 ? 1 : 2); memberIndex++) {
      const memberKey = `agent:main:dashboard:group-${groupIndex}-member-${memberIndex}`;
      await peer.request("sessions.create", { agentId: "main", key: memberKey, category });
      const member = await describe(memberKey);
      assert.equal(member.category, category);
      members.push({ key: memberKey, category, updatedAt: member.updatedAt });
    }
  }
  const initial = await peer.request<GroupCatalog>("sessions.groups.put", { names, sectionOrder });
  assert.deepEqual(initial.groups, groups);
  assert.deepEqual(initial.sectionOrder, sectionOrder);
  // Make an accidental updatedAt write observable even on millisecond-resolution clocks.
  await setTimeout(2);
  assert(Date.now() > Math.max(...members.map((member) => member.updatedAt)));
  const operations: Array<{ phase: string; updatedSessions: number; verifiedMembers: number }> = [];
  for (let index = 0; index <= warmMutations; index++) {
    const from = `Group ${index}`;
    const to = `Renamed ${index}`;
    const label = index === 0 ? `cold-${action}` : `warm-${action}-${index}`;
    phase(label);
    const result = await peer.request<GroupCatalog & { ok: true; updatedSessions: number }>(
      `sessions.groups.${action}`,
      action === "rename" ? { name: from, to } : { name: from },
    );
    phase(`readback-${action}-${index}`);
    assert.equal(result.ok, true);
    assert.equal(result.updatedSessions, 2);
    const sourceGroup = groups.find((group) => group.name === from);
    assert(sourceGroup);
    if (action === "rename") {
      sourceGroup.name = to;
      sectionOrder = sectionOrder.map((section) =>
        section === `category:${from}` ? `category:${to}` : section,
      );
    } else {
      groups.splice(groups.indexOf(sourceGroup), 1);
      sectionOrder = sectionOrder.filter((section) => section !== `category:${from}`);
    }
    for (const member of members) {
      if (member.category === from) {
        member.category = action === "rename" ? to : undefined;
      }
      const current = await describe(member.key);
      assert.equal(current.category, member.category);
      assert.equal(current.updatedAt, member.updatedAt);
    }
    assert.deepEqual(result.groups, groups);
    assert.deepEqual(result.sectionOrder, sectionOrder);
    const listed = await peer.request<GroupCatalog>("sessions.groups.list", {});
    assert.deepEqual(listed.groups, groups);
    assert.deepEqual(listed.sectionOrder, sectionOrder);
    operations.push({
      phase: label,
      updatedSessions: result.updatedSessions,
      verifiedMembers: members.length,
    });
  }
  return { ok: true, workload: action, warmMutations, operations };
}

try {
  peer.start();
  await ready.promise;
  let outcome;
  if (workload === "registration") {
    await assign("Cold", true);
    for (let index = 0; index < registrations; index++) {
      await assign(`Warm ${index}`);
    }
    for (let index = 0; index < registrations; index++) {
      const label = `warm-existing-${index}`;
      phase(label);
      const started = performance.now();
      const result = await peer.request<{ entry: { category: string } }>("sessions.patch", {
        key,
        category: "Cold",
      });
      timings.push({ phase: label, ms: performance.now() - started });
      assert.equal(result.entry.category, "Cold");
    }
    phase("readback");
    const listed = await peer.request<{ groups: Array<{ name: string; position: number }> }>(
      "sessions.groups.list",
      {},
    );
    assert.deepEqual(listed.groups, expected);
    outcome = { ok: true, registrations, timings };
  } else {
    outcome = await runMutations(workload);
  }
  writeFileSync(path.join(directory, "result.json"), JSON.stringify(outcome, null, 2));
  console.log(JSON.stringify(outcome));
} finally {
  phase("shutdown");
  peer.stop();
  await server.close({ reason: "synthetic category registration completed" });
}
