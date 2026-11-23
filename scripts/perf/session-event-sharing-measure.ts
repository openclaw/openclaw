/**
 * Real connection-state authorization/broadcast replay with inert transport sinks.
 * One committed shared row, 65 clients, 40 plugin config entries; row cardinality
 * does not affect this exact-key path. Whole-Gateway load is a separate proof.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-event-sharing-measure.ts
 * --source <saved-server-connection-state.ts> pins the owner without changing imports.
 * --sharing-source <saved-session-sharing-read.ts> pins the authorization owner too.
 * --compare-source <candidate> runs counterbalanced pairs in the same process;
 * --compare-sharing-source defaults to the current authorization owner.
 * --clients 16/32/65 --events 5000 --passes 5; alternate base/candidate processes.
 * --named interleaves eight named audiences; default matches shared-secret admins.
 * --allocations collects short-lived objects in a separate sampling pass.
 * CPU/tails exclude digest replay; all arms must have identical complete-frame
 * digests. Compare A/A controls before treating timing noise as a regression.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { setRuntimeConfigSnapshot } from "../../src/config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { SerializedGatewayFrame } from "../../src/gateway/serialized-json.js";
import type { GatewayWsClient } from "../../src/gateway/server/ws-types.js";
import { createSessionRowProjection } from "../../src/gateway/session-row-projection.js";
import { createTestGatewayScheduler } from "../../src/test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "src/gateway/server-connection-state.ts" },
    "compare-source": { type: "string" },
    "sharing-source": { type: "string", default: "src/gateway/session-sharing-read.ts" },
    "compare-sharing-source": { type: "string", default: "src/gateway/session-sharing-read.ts" },
    clients: { type: "string", default: "65" },
    events: { type: "string", default: "5000" },
    passes: { type: "string", default: "5" },
    named: { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
  },
});
const integer = (name: "clients" | "events" | "passes") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const clients = integer("clients"),
  events = integer("events"),
  passes = integer("passes");
const sources = values["compare-source"]
  ? [values.source, values["compare-source"]]
  : [values.source];
const owners: {
  create: typeof import("../../src/gateway/server-connection-state.js").createGatewayConnectionState;
  sha256: string;
  sharingSha256: string;
  arm: "base" | "candidate";
}[] = [];
for (const [index, sourcePath] of sources.entries()) {
  const source = readFileSync(path.resolve(sourcePath), "utf8");
  const ownerUrl = new URL(
    `../../src/gateway/server-connection-state.ts?sharing-bench=${index}`,
    import.meta.url,
  ).href;
  const sharingSource = readFileSync(
    path.resolve(index === 0 ? values["sharing-source"] : values["compare-sharing-source"]),
    "utf8",
  );
  const sharingPath = `./session-sharing-read.ts?sharing-bench=${index}`;
  const sharingUrl = new URL(sharingPath, ownerUrl).href;
  assert(source.includes('from "./session-sharing.js"'), "Expected sharing owner import");
  const measuredSource = source.replace('from "./session-sharing.js"', `from "${sharingPath}"`);
  const hook = registerHooks({
    load(url, context, nextLoad) {
      if (url === ownerUrl || url === sharingUrl) {
        return {
          format: "module-typescript",
          source: url === ownerUrl ? measuredSource : sharingSource,
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
  });
  const owner: typeof import("../../src/gateway/server-connection-state.js") = await import(
    ownerUrl
  );
  hook.deregister();
  owners.push({
    create: owner.createGatewayConnectionState,
    sha256: createHash("sha256").update(source).digest("hex"),
    sharingSha256: createHash("sha256").update(sharingSource).digest("hex"),
    arm: index === 0 ? "base" : "candidate",
  });
}
await withOpenClawTestState({ scenario: "minimal" }, async () => {
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    plugins: {
      entries: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`fixture-${i}`, { enabled: true }]),
      ),
    },
  };
  setRuntimeConfigSnapshot(cfg);
  const scope = { agentId: "main", sessionKey: "agent:main:sharing-replay" };
  await upsertSessionEntryCore(scope, {
    sessionId: "sharing-replay",
    updatedAt: 1,
    visibility: "shared",
  });
  const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
  await projection.ensureMaterialized();
  try {
    for (let pass = 0; pass < passes; pass++) {
      for (const owner of pass % 2 ? owners.toReversed() : owners) {
        const state = owner.create({
          cfg,
          scheduler: createTestGatewayScheduler(),
          bootId: "sharing-replay",
        });
        const detach = state.attachSessionRowProjection(projection);
        let digest: ReturnType<typeof createHash> | undefined;
        let deliveries = 0;
        for (let i = 0; i < clients; i++) {
          const emitter = new EventEmitter();
          const profileId = `audience-${i % 8}`;
          const client: GatewayWsClient = {
            connId: `recipient-${i}`,
            usesSharedGatewayAuth: !values.named,
            connect: {
              minProtocol: 3,
              maxProtocol: 3,
              role: "operator",
              client: {
                id: "openclaw-control-ui",
                version: "replay",
                platform: "web",
                mode: "webchat",
              },
              scopes: [values.named ? "operator.read" : "operator.admin"],
            },
            socket: Object.assign(emitter, {
              readyState: 1,
              bufferedAmount: 0,
              close() {},
              terminate() {},
              send(frame: string | Buffer | SerializedGatewayFrame) {
                deliveries++;
                digest?.update(String(frame));
              },
            }),
          };
          if (values.named) {
            client.authenticatedUserProfile = {
              profileId,
              displayName: null,
              hasAvatar: false,
              avatarRevision: "synthetic",
              updatedAt: 1,
            };
            client.preparedSessionProfile = {
              profileId,
              aliases: new Set([profileId]),
              role: null,
            };
          }
          state.clients.add(client);
        }
        const recipients = new Set([...state.clients].map((client) => client.connId));
        const publish = (index: number) =>
          state.broadcastToConnIds(
            "chat",
            {
              sessionKey: scope.sessionKey,
              runId: "replay",
              seq: index,
              state: "delta",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Synthetic response" }],
              },
            },
            recipients,
            { agentId: "main", sessionKeys: [scope.sessionKey] },
          );
        try {
          for (let i = 0; i < 500; i++) {
            publish(i);
          }
          global.gc?.();
          const inspector = new Session();
          if (values.allocations) {
            inspector.connect();
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 16384,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          const hostLoad = loadavg();
          const durations = new Float64Array(events);
          const cpuStart = process.threadCpuUsage();
          for (let i = 0; i < events; i++) {
            const start = performance.now();
            publish(i);
            durations[i] = performance.now() - start;
          }
          const cpu = process.threadCpuUsage(cpuStart);
          let sampledBytes: number | undefined;
          if (values.allocations) {
            const { profile } = await inspector.post("HeapProfiler.stopSampling");
            const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
              node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
            sampledBytes = sum(profile.head);
            inspector.disconnect();
          }
          digest = createHash("sha256");
          deliveries = 0;
          for (let i = 0; i < events; i++) {
            publish(i);
          }
          assert.equal(deliveries, events * clients);
          durations.sort();
          console.log(
            JSON.stringify({
              sourceSha256: owner.sha256,
              sharingSha256: owner.sharingSha256,
              arm: owner.arm,
              pass,
              clients,
              events,
              named: values.named,
              mode: values.allocations ? "allocation" : "timing",
              cpuMsPerPublication: (cpu.user + cpu.system) / 1000 / events,
              bytesPerPublication: sampledBytes === undefined ? undefined : sampledBytes / events,
              p50: durations[Math.floor(events * 0.5)],
              p99: durations[Math.floor(events * 0.99)],
              max: durations[events - 1],
              over180: durations.filter((value) => value > 180).length,
              digest: digest.digest("hex"),
              deliveries,
              hostLoad,
            }),
          );
        } finally {
          detach();
          state.clients.clear();
          await state.mentionInbox.dispose();
        }
      }
    }
  } finally {
    projection.dispose();
  }
});
