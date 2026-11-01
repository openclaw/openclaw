// Owner microbenchmark: 65 recipients and watches, five interleaved authorization audiences.
// Run: node --import ./scripts/tsx.mjs scripts/perf/presence-projection-measure.ts
// --owner <saved-presence-projection.ts> selects the exact baseline owner with the same fixture.
// --allocations runs a separate sampled-allocation pass; its timing is diagnostic only.
// --distinct-profiles gives each named recipient a unique identity to measure the no-sharing case.
// Wire hashing and authority-change assertions run outside measurement. No Gateway or stores.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import type { SessionRowProjection } from "../../src/gateway/session-row-projection.js";
import type { SystemPresence } from "../../src/infra/system-presence.js";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";

const { values } = parseArgs({
  options: {
    allocations: { type: "boolean", default: false },
    "distinct-profiles": { type: "boolean", default: false },
    owner: { type: "string" },
    iterations: { type: "string", default: "3000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const ownerUrl = new URL("../../src/gateway/presence-projection.ts", import.meta.url);
const ownerSource = readFileSync(values.owner ?? ownerUrl, "utf8");
let ownerLoaded = false;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== ownerUrl.href) {
      return nextLoad(url, context);
    }
    ownerLoaded = true;
    return { format: "module", source: stripTypeScriptTypes(ownerSource), shortCircuit: true };
  },
});
const { createPresenceRecipientProjection } =
  await import("../../src/gateway/presence-projection.js");
hooks.deregister();
assert(ownerLoaded, "The selected presence owner must be loaded");

function fixture() {
  let cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
        },
      },
    },
  };
  let revision = {};
  let targetReads = 0;
  const keys = Array.from({ length: 65 }, (_, index) => `agent:main:synthetic-${index}`);
  const targets = new Map<string, NonNullable<ReturnType<SessionRowProjection["sharingTarget"]>>>(
    keys.map((key, index) => [
      key,
      {
        agentId: "main",
        generation: Symbol("fixture-row"),
        canonicalKey: key,
        storeKey: key,
        storeKeys: [key],
        storePath: "/synthetic/session-store.sqlite",
        entry: {
          sessionId: `session-${index}`,
          updatedAt: 1,
          visibility: index % 4 === 0 ? ("draft" as const) : ("shared" as const),
          createdActor: {
            type: "human" as const,
            source: "profile" as const,
            id: `profile-${index % 2}`,
          },
        },
      },
    ]),
  );
  const presence: SystemPresence[] = keys.map((key, index) => ({
    connectionId: `connection-${index}`,
    host: `synthetic-workstation-${index}`,
    text: "Synthetic operator presence",
    ts: 1_700_000_000_000,
    platform: "macos",
    user: { id: `profile-${index % 2}`, name: `Synthetic Operator ${index % 2}` },
    watchedSessions: [key],
  }));
  const clients: GatewayClient[] = keys.map((_key, index) => {
    const audience = index % 5;
    const profileId = `profile-${audience === 2 ? 1 : 0}`;
    const client: GatewayClient = {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        role: "operator",
        scopes: [
          audience === 0 ? "operator.admin" : audience === 4 ? "operator.pairing" : "operator.read",
        ],
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      },
    };
    if (audience === 3) {
      client.authenticatedGitHubIdentitySync = async () => ({ profileId, updatedAt: 1 });
    } else {
      client.authenticatedUserProfile = {
        profileId,
        updatedAt: 1,
        displayName: profileId,
        avatarRevision: "1",
        hasAvatar: false,
      };
      client.preparedSessionProfile = { profileId, aliases: new Set([profileId]), role: "reader" };
    }
    return client;
  });
  // Only the resident target adapter is synthetic; routing and all recipient policy are real.
  const projection = {
    getPolicyConfig: () => cfg,
    get sharingRevision() {
      return revision;
    },
    sharingTargetState: ({ key }: { key: string }) => {
      targetReads++;
      const target = targets.get(key);
      return target ? { status: "ready", target } : { status: "missing" };
    },
    hasMembership: () => false,
  } satisfies Pick<
    SessionRowProjection,
    "getPolicyConfig" | "sharingRevision" | "sharingTargetState" | "hasMembership"
  >;
  return {
    clients,
    presence,
    targets,
    project: () =>
      createPresenceRecipientProjection({
        cfg,
        presence,
        projection,
      }),
    restrict: () => {
      cfg = {
        ...cfg,
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
            },
          },
        },
      };
    },
    solo: () => {
      cfg = { agents: { entries: { main: {} } } };
    },
    invalidate: () => {
      revision = {};
    },
    get targetReads() {
      return targetReads;
    },
    resetCounts: () => {
      targetReads = 0;
    },
  };
}

const proof = fixture();
const projectProof = proof.project();
const digest = createHash("sha256");
let proofFrames = 0;
const recordFrames = () => {
  for (const client of proof.clients) {
    digest.update(
      JSON.stringify({
        type: "event",
        event: "presence",
        payload: { presence: projectProof(client) },
      }),
    );
    proofFrames++;
  }
};
const visible = (client: GatewayClient) =>
  projectProof(client).flatMap((row) => row.watchedSessions ?? []);
assert.equal(visible(proof.clients[0]!).length, 65);
assert.equal(visible(proof.clients[1]!).length, 65);
assert.equal(visible(proof.clients[2]!).length, 48);
assert.equal(visible(proof.clients[3]!).length, 0);
assert.equal(projectProof(proof.clients[4]!).length, 0);
recordFrames();
// Reusing the same projector must still reflect in-place scope revocation and restoration.
proof.clients[0]!.connect.scopes![0] = "operator.pairing";
assert.equal(projectProof(proof.clients[0]!).length, 0);
recordFrames();
proof.clients[0]!.connect.scopes![0] = "operator.admin";
proof.restrict();
assert.equal(visible(proof.clients[1]!).length, 33);
assert.equal(visible(proof.clients[2]!).length, 32);
recordFrames();
proof.targets.delete("agent:main:synthetic-0");
proof.invalidate();
assert.equal(visible(proof.clients[0]!).length, 64);
recordFrames();
const solo: GatewayClient = {
  connect: { ...proof.clients[1]!.connect, scopes: ["operator.write"] },
};
assert.equal(visible(solo).length, 0);
solo.internal = { operatorRoleActor: { kind: "system" } };
assert.equal(visible(solo).length, 64);
solo.internal = undefined;
proof.solo();
assert.equal(visible(solo).length, 64);
assert.equal(visible(proof.clients[3]!).length, 0);
digest.update(JSON.stringify(projectProof(solo)));
proofFrames++;
solo.connect.role = "node";
assert.equal(projectProof(solo).length, 0);
assert.equal(projectProof(null).length, 0);

const workload = fixture();
if (values["distinct-profiles"]) {
  for (const [index, client] of workload.clients.entries()) {
    if (client.authenticatedUserProfile && client.preparedSessionProfile) {
      const profileId = `distinct-profile-${index}`;
      client.authenticatedUserProfile.profileId = profileId;
      client.preparedSessionProfile.profileId = profileId;
      client.preparedSessionProfile.aliases = new Set([profileId]);
    }
  }
}
const workloadDigest = createHash("sha256");
const projectWorkload = workload.project();
for (const client of workload.clients) {
  workloadDigest.update(
    JSON.stringify({
      type: "event",
      event: "presence",
      payload: { presence: projectWorkload(client) },
    }),
  );
}
let consumedRows = 0;
async function run(count: number) {
  for (let iteration = 0; iteration < count; iteration++) {
    const project = workload.project();
    for (const client of workload.clients) {
      consumedRows += project(client).length;
    }
    if (iteration % 100 === 0) {
      await nextTurn();
    }
  }
}
await run(300);
workload.resetCounts();
consumedRows = 0;
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const stopDiagnostics = startGatewayBenchDiagnostics();
const cpu = process.threadCpuUsage();
const start = performance.now();
await run(iterations);
const wallMs = performance.now() - start;
const used = process.threadCpuUsage(cpu);
await nextTurn();
await nextTurn();
const diagnostics = stopDiagnostics();
let allocatedBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    publications: iterations,
    distinctProfiles: values["distinct-profiles"],
    workloadWireDigest: workloadDigest.digest("hex"),
    ownerSha256: createHash("sha256").update(ownerSource).digest("hex"),
    recipients: workload.clients.length,
    watches: workload.presence.length,
    wallMs,
    threadCpuMs: (used.user + used.system) / 1000,
    allocatedBytes,
    targetReads: workload.targetReads,
    consumedRows,
    proofFrames,
    wireDigest: digest.digest("hex"),
    memory: process.memoryUsage(),
    hostLoad: loadavg(),
    diagnostics,
  }),
);
