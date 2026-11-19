/**
 * Session event audience preparation: 65 recipients, eight identities, two fast-mode
 * capabilities and 40 resident plugin metadata records. Runs the real publication,
 * sharing/model-policy preparation and row presenter against one warm synthetic row.
 * This isolates repeated audience preparation; it is not a Gateway load test.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-event-audience-measure.ts \
 *   --base-owner src/gateway/.base-presentation.ts --pairs 5 --events 3000
 * --owner selects the candidate; --allocations runs a separate sampled-allocation
 * pass; --profiles saves each sampling profile under --state-root for attribution.
 * Pairs alternate AB/BA, sharing prewarmed fixtures and import setup outside
 * measurement. Acceptance: equal per-recipient row digest and presentation
 * counts, lower CPU/allocation; report absolute costs and host load for every arm.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/gateway/session-row-presentation.ts" },
    "base-owner": { type: "string" },
    pairs: { type: "string", default: "5" },
    events: { type: "string", default: "3000" },
    clients: { type: "string", default: "65" },
    allocations: { type: "boolean", default: false },
    profiles: { type: "boolean", default: false },
    "state-root": { type: "string", default: ".local/session-event-audience-measure" },
  },
});
const events = Number(values.events);
const pairs = Number(values.pairs);
assert(Number.isSafeInteger(pairs) && pairs > 0);
assert(values["base-owner"], "--base-owner must name the saved source sibling");
const clientCount = Number(values.clients);
assert(Number.isSafeInteger(events) && events > 0);
assert(Number.isSafeInteger(clientCount) && clientCount > 0);
const owner = path.resolve(values.owner);
type Owner = typeof import("../../src/gateway/session-row-presentation.js");
const candidate: Owner = await import(pathToFileURL(owner).href);
const baseOwner = path.resolve(values["base-owner"]);
const base: Owner = await import(pathToFileURL(baseOwner).href);
const variants = [
  { name: "base", prepare: base.prepareSessionRowPublication, source: baseOwner },
  { name: "candidate", prepare: candidate.prepareSessionRowPublication, source: owner },
];
const { createSessionRowProjection } = await import("../../src/gateway/session-row-projection.js");
const { replaceSessionEntrySync } = await import("../../src/config/sessions/session-accessor.js");
const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { freezeTrustedJsonSnapshot } = await import("../../src/shared/immutable-data.js");
const { createPluginMetadataSnapshotFixture } =
  await import("../../src/plugins/plugin-metadata.test-support.js");
const { setCurrentPluginMetadataSnapshotState, clearCurrentPluginMetadataSnapshot } =
  await import("../../src/plugins/current-plugin-metadata-state.js");
const { serializeSessionRow } = await import("../../src/gateway/session-row-serialization.js");

const stateRoot = path.resolve(values["state-root"]);
mkdirSync(stateRoot, { recursive: true });
const previousTmp = process.env.TMPDIR;
process.env.TMPDIR = stateRoot;
const previousNow = Date.now;
Date.now = () => 1_000_000;
try {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg: OpenClawConfig = freezeTrustedJsonSnapshot({
      agents: {
        entries: { main: {} },
        defaults: { model: { primary: "mock/private" } },
      },
      plugins: {
        entries: Object.fromEntries(
          Array.from({ length: 40 }, (_, index) => [`fixture-${index}`, { enabled: true }]),
        ),
      },
      gateway: {
        roles: {
          default: "viewer",
          definitions: {
            viewer: {
              sessions: { others: "view" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
              modelPolicy: { allow: ["mock/visible"], deny: ["mock/private"] },
            },
          },
        },
      },
    });
    setCurrentPluginMetadataSnapshotState(
      createPluginMetadataSnapshotFixture({
        plugins: Array.from({ length: 40 }, (_, index) => ({ id: `fixture-${index}` })),
      }),
      "audience-measure",
      undefined,
      undefined,
      "gateway",
    );
    const clients: GatewayClient[] = Array.from({ length: clientCount }, (_, index) => {
      const profileId = `synthetic-${index % 8}`;
      return {
        connId: `synthetic-connection-${index}`,
        authenticatedUserId: profileId,
        authenticatedUserProfile: { profileId, displayName: null, hasAvatar: false, updatedAt: 1 },
        preparedSessionProfile: {
          profileId,
          aliases: new Set([profileId]),
          role: "viewer",
          githubLogin: null,
        },
        connect: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "openclaw-control-ui", version: "bench", platform: "bench", mode: "ui" },
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          caps: Math.floor(index / 8) % 2 ? ["ultrafast"] : [],
        },
      };
    });
    const key = "agent:main:audience-measure";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "synthetic-session",
        updatedAt: 1,
        visibility: "shared",
        label: "Synthetic streamed tool turn",
        modelProvider: "mock",
        model: "private",
        fastMode: "ultrafast",
      },
    );
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const inspector = new Session();
    try {
      const captured = projection.describe({ key, agentId: "main" });
      assert(captured);
      const record = captured;
      let checksum = 0;
      let presentations = 0;
      function publish(variant: (typeof variants)[number], digest?: ReturnType<typeof createHash>) {
        const publication = variant.prepare(projection, Date.now());
        const audiences = new Map<string, string>();
        for (const client of clients) {
          const recipient = publication(client);
          const audienceKey = recipient.getAudienceKey();
          let encoded = audiences.get(audienceKey);
          if (encoded === undefined) {
            const row = recipient.getPresentation().present(record);
            assert(row);
            assert.equal(row.model, undefined, "model policy must redact the private model");
            encoded = serializeSessionRow(row);
            audiences.set(audienceKey, encoded);
            presentations++;
          }
          checksum += encoded.length;
          digest?.update(encoded);
        }
      }
      for (let index = 0; index < 100; index++) {
        for (const variant of variants) {
          publish(variant);
        }
      }
      const digests = variants.map((variant) => {
        const digest = createHash("sha256");
        publish(variant, digest);
        return digest.digest("hex");
      });
      assert.equal(digests[0], digests[1], "per-recipient rows must remain byte-identical");
      const results: Array<{
        pair: number;
        variant: string;
        presentations: number;
        elapsedMs: number;
        threadCpuMs: number;
        sampledBytes: number | undefined;
        checksum: number;
        hostLoadBefore: number[];
        hostLoadAfter: number[];
        memoryBefore: NodeJS.MemoryUsage;
        memoryAfter: NodeJS.MemoryUsage;
      }> = [];
      if (values.allocations) {
        inspector.connect();
      }
      for (let pair = 0; pair < pairs; pair++) {
        for (const variant of pair % 2 ? variants.toReversed() : variants) {
          global.gc?.();
          checksum = 0;
          presentations = 0;
          if (values.allocations) {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 16384,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          const hostLoadBefore = loadavg();
          const memoryBefore = process.memoryUsage();
          const cpuStart = process.threadCpuUsage();
          const started = performance.now();
          for (let index = 0; index < events; index++) {
            publish(variant);
          }
          const elapsedMs = performance.now() - started;
          const cpu = process.threadCpuUsage(cpuStart);
          const memoryAfter = process.memoryUsage();
          let sampledBytes: number | undefined;
          if (values.allocations) {
            const { profile } = await inspector.post("HeapProfiler.stopSampling");
            const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
              node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
            sampledBytes = sum(profile.head);
            if (values.profiles) {
              writeFileSync(
                path.join(stateRoot, `${variant.name}-${pair}.heapprofile`),
                JSON.stringify(profile),
              );
            }
          }
          results.push({
            pair,
            variant: variant.name,
            presentations,
            elapsedMs,
            threadCpuMs: (cpu.user + cpu.system) / 1000,
            sampledBytes,
            checksum,
            hostLoadBefore,
            hostLoadAfter: loadavg(),
            memoryBefore,
            memoryAfter,
          });
        }
      }
      for (let pair = 0; pair < pairs; pair++) {
        const [first, second] = results.slice(pair * 2, pair * 2 + 2);
        assert.equal(first?.presentations, second?.presentations);
        assert.equal(first?.checksum, second?.checksum);
      }
      console.log(
        JSON.stringify({
          sources: variants.map((variant) => ({
            name: variant.name,
            sha256: createHash("sha256").update(readFileSync(variant.source)).digest("hex"),
          })),
          node: process.version,
          events,
          pairs,
          clients: clientCount,
          mode: values.allocations ? "allocation" : "timing",
          digest: digests[0],
          results,
        }),
      );
    } finally {
      inspector.disconnect();
      projection.dispose();
      clearCurrentPluginMetadataSnapshot();
    }
  });
} finally {
  Date.now = previousNow;
  if (previousTmp === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmp;
  }
}
