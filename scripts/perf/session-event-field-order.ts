/**
 * Real projection/broadcast owner, 66 delta/ref recipients across three authorization profiles.
 * Compare divergent delivery versions with an aligned-history control; exact wire bytes must match.
 * Save the trusted comparison owner, then run five counterbalanced pairs in one process:
 * git show <base>:src/gateway/session-event-projection.ts > .local/base-projection.ts
 * node --import ./scripts/tsx.mjs scripts/perf/session-event-field-order.ts \
 *   --baseline-source .local/base-projection.ts --publications 500 --pairs 5
 * CPU and sampled allocation use separate counterbalanced phases.
 * CPU is untraced; sampled allocation includes collected objects.
 * Field-enumeration counts are diagnostic: newer baselines may already avoid tuples.
 * This measures owner work only, not whole-Gateway latency or throughput.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { SerializedGatewayFrame } from "../../src/gateway/serialized-json.js";
import type { GatewayWsClient } from "../../src/gateway/server/ws-types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "baseline-source": { type: "string" },
    publications: { type: "string", default: "500" },
    pairs: { type: "string", default: "5" },
    clients: { type: "string", default: "66" },
    "sampling-interval": { type: "string", default: "16384" },
    "state-root": { type: "string", default: ".local/session-event-field-order" },
  },
});
const integer = (key: "publications" | "pairs" | "clients" | "sampling-interval", min: number) =>
  parseStrictIntegerOption({ raw: values[key], fallback: min, min, label: `--${key}` });
const publications = integer("publications", 1);
const pairs = integer("pairs", 1);
const clientCount = integer("clients", 1);
const samplingInterval = integer("sampling-interval", 1024);
const ownerUrl = new URL("../../src/gateway/session-event-projection.ts", import.meta.url);
const baselineUrl = `${ownerUrl.href}?field-order-baseline`;
assert(values["baseline-source"], "--baseline-source is required");
const baselineSource = readFileSync(values["baseline-source"], "utf8");
let baselineLoaded = false;
const sourceHash = (source: string) => createHash("sha256").update(source).digest("hex");
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url === baselineUrl) {
      baselineLoaded = true;
      return { format: "module-typescript", source: baselineSource, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const baseline: typeof import("../../src/gateway/session-event-projection.js") = await import(
  baselineUrl
);
assert(baselineLoaded, "baseline owner was not loaded");
hook.deregister();
const { prepareSessionEventProjection } =
  await import("../../src/gateway/session-event-projection.js");
const { createGatewayConnectionState } =
  await import("../../src/gateway/server-connection-state.js");
const { prepareGatewayRecipientProfile } = await import("../../src/gateway/expected-profile.js");
const { createSessionRowProjection } = await import("../../src/gateway/session-row-projection.js");
const { replaceSessionEntrySync } = await import("../../src/config/sessions/session-accessor.js");
const { ensureProfileForEmail } = await import("../../src/state/user-profiles.js");
const { setUserProfileRole } = await import("../../src/state/user-profile-writes.worker.js");
const { createTestGatewayScheduler } =
  await import("../../src/test-utils/gateway-scheduler-clock.js");
const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");

const temporaryRoot = path.resolve(values["state-root"]);
mkdirSync(temporaryRoot, { recursive: true });
const previousTmp = process.env.TMPDIR;
process.env.TMPDIR = temporaryRoot;
const now = Date.now;
Date.now = () => 1_000_000;
try {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      gateway: {
        roles: {
          default: "view",
          definitions: {
            view: {
              sessions: { others: "view" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
            },
            write: {
              sessions: { others: "write" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
            },
          },
        },
      },
    };
    const profiles = ["owner", "member", "viewer"].map((role) => {
      const profile = ensureProfileForEmail(`field-order-${role}@example.test`);
      setUserProfileRole(profile.id, role === "member" ? "write" : "view");
      return profile;
    });
    const root = "agent:main:field-order-root";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: root },
      {
        sessionId: root,
        label: `${root}: ${"synthetic session description ".repeat(12)}`,
        modelProvider: "mock",
        model: "fixture",
        inputTokens: 12000,
        outputTokens: 4000,
        totalTokens: 16000,
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: profiles[0]!.id },
      },
    );
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const results: unknown[] = [];
    for (const history of ["divergent", "aligned"] as const) {
      const variants = [
        {
          name: "base",
          prepare: baseline.prepareSessionEventProjection,
        },
        {
          name: "candidate",
          prepare: prepareSessionEventProjection,
        },
      ].map(({ name, prepare }) => {
        const connection = createGatewayConnectionState({
          cfg,
          scheduler: createTestGatewayScheduler(),
          bootId: `field-order-${name}`,
        });
        const detach = connection.attachSessionRowProjection(projection);
        const peers = Array.from({ length: clientCount }, (_, index) => {
          const profile = profiles[index % profiles.length]!;
          const received = {
            count: 0,
            last: undefined as string | Buffer | SerializedGatewayFrame | undefined,
          };
          const socket = Object.assign(new EventEmitter(), {
            readyState: 1,
            bufferedAmount: 0,
            send(
              frame: string | Buffer | SerializedGatewayFrame,
              options?: { binary: false } | ((error?: Error) => void),
              done?: (error?: Error) => void,
            ) {
              received.count++;
              received.last = frame;
              (typeof options === "function" ? options : done)?.();
            },
            close() {},
            terminate() {},
          });
          const client: GatewayWsClient = {
            connId: `${name}-${index}`,
            socket,
            usesSharedGatewayAuth: false,
            authenticatedUserId: profile.id,
            authenticatedUserProfile: {
              profileId: profile.id,
              displayName: profile.displayName,
              avatarRevision: "1",
              hasAvatar: false,
              updatedAt: 1,
            },
            connect: {
              minProtocol: 1,
              maxProtocol: 1,
              client: {
                id: "openclaw-control-ui",
                version: "benchmark",
                platform: "benchmark",
                mode: "webchat",
              },
              role: "operator",
              scopes: ["operator.read", "operator.write"],
              caps: ["session-row-deltas", "session-event-field-refs"],
            },
          };
          prepareGatewayRecipientProfile(client);
          connection.clients.add(client);
          connection.sessionEventSubscribers.subscribe(client.connId);
          if (history === "divergent") {
            for (let prior = 0; prior <= Math.floor(index / profiles.length); prior++) {
              connection.broadcastToConnIds(
                "sessions.changed",
                { sessionKey: root, agentId: "main", reason: "send" },
                new Set([client.connId]),
                { prepareSessionProjection: prepare(projection) },
              );
            }
            assert(received.count > 0, "recipient priming failed");
          }
          return { client, received };
        });
        const payload = { sessionKey: root, agentId: "main", reason: "send" };
        return {
          name,
          connection,
          detach,
          peers,
          publish() {
            connection.broadcast("sessions.changed", payload, {
              prepareSessionProjection: prepare(projection),
            });
          },
        };
      });
      const verify = () => {
        for (let index = 0; index < clientCount; index++) {
          const a = variants[0]!.peers[index]!.received;
          const b = variants[1]!.peers[index]!.received;
          assert.equal(a.count, b.count);
          assert.equal(
            a.last?.toString(),
            b.last?.toString(),
            `wire mismatch at recipient ${index}`,
          );
        }
      };
      const run = async (variant: (typeof variants)[number], count: number) => {
        for (let index = 0; index < count; index++) {
          variant.publish();
          if ((index + 1) % 100 === 0) {
            await yieldToLoop();
          }
        }
      };
      const inspector = new Session();
      const measurements: unknown[] = [];
      try {
        const fieldEnumerations: Record<string, number> = {};
        for (const variant of variants) {
          const original = Object.entries;
          let count = 0;
          try {
            Object.entries = (value: Parameters<typeof Object.entries>[0]) => {
              if (isRecord(value) && value.key === root && typeof value.sharingRole === "string") {
                count++;
              }
              return original(value);
            };
            variant.publish();
          } finally {
            Object.entries = original;
          }
          fieldEnumerations[variant.name] = count;
        }
        verify();
        for (const variant of variants) {
          await run(variant, 100);
        }
        for (const phase of ["cpu", "allocation"] as const) {
          if (phase === "allocation") {
            inspector.connect();
          }
          for (let pair = 0; pair < pairs; pair++) {
            for (const variant of pair % 2 === 0 ? variants : variants.toReversed()) {
              await yieldToLoop();
              if (phase === "allocation") {
                await inspector.post("HeapProfiler.startSampling", {
                  samplingInterval,
                  includeObjectsCollectedByMajorGC: true,
                  includeObjectsCollectedByMinorGC: true,
                });
              }
              const hostLoadBefore = loadavg();
              const before = process.threadCpuUsage();
              const started = performance.now();
              await run(variant, publications);
              const elapsedMs = performance.now() - started;
              const cpu = process.threadCpuUsage(before);
              const profile =
                phase === "allocation"
                  ? (await inspector.post("HeapProfiler.stopSampling")).profile
                  : undefined;
              const allocatedBytes = profile?.samples.reduce((sum, sample) => sum + sample.size, 0);
              measurements.push({
                phase,
                pair,
                variant: variant.name,
                publications,
                elapsedMs,
                hostLoadBefore,
                hostLoadAfter: loadavg(),
                mainThreadCpuMsPerPublication: (cpu.user + cpu.system) / 1000 / publications,
                ...(allocatedBytes === undefined
                  ? {}
                  : { sampledAllocatedBytesPerPublication: allocatedBytes / publications }),
              });
            }
            verify();
          }
          if (phase === "allocation") {
            inspector.disconnect();
          }
        }
        results.push({ history, fieldEnumerations, measurements });
      } finally {
        inspector.disconnect();
        for (const variant of variants) {
          for (const { client } of variant.peers) {
            variant.connection.clients.delete(client);
          }
          variant.detach();
          await variant.connection.mentionInbox.dispose();
        }
      }
    }
    projection.dispose();
    console.log(
      JSON.stringify(
        {
          clientCount,
          audiences: profiles.length,
          publications,
          pairs,
          samplingInterval,
          sourceSha256: {
            base: sourceHash(baselineSource),
            candidate: sourceHash(readFileSync(ownerUrl, "utf8")),
          },
          results,
        },
        null,
        2,
      ),
    );
  });
} finally {
  Date.now = now;
  if (previousTmp === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmp;
  }
}
