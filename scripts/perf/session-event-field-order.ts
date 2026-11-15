/**
 * Real projection/broadcast owner, mixed legacy/delta/ref recipients across three profiles.
 * Compare divergent delivery versions with an aligned-history control; exact wire bytes must match.
 * Save the trusted comparison owner, then run five counterbalanced pairs in one process:
 * git show <base>:src/gateway/session-event-projection.ts > .local/base-projection.ts
 * node --import ./scripts/tsx.mjs scripts/perf/session-event-field-order.ts \
 *   --baseline-source .local/base-projection.ts --publications 500 --pairs 5
 * --baseline-ancestor-source <file.ts> isolates the saved ancestor owner for both
 * baseline connection histories and event projection; candidate imports stay current.
 * CPU and sampled allocation use separate counterbalanced phases.
 * CPU is untraced; sampled allocation includes collected objects.
 * Field-enumeration counts are diagnostic: newer baselines may already avoid tuples.
 * --reuse-envelope enables the producer-owned envelope contract on both revisions.
 * --corpus <path.jsonl> records exact frames and SHA-256 hashes for mixed messages,
 * omission preferences, ancestor visibility and targeted/full publication histories.
 * Corpus checks run before measurement; fixed publication UUIDs keep ancestor
 * certificates byte-comparable without normalizing any emitted frame.
 * --client-reads requires --corpus and runs only the instrumented corpus, skipping
 * timing/allocation. Stable client proxies record plain-object/array reads; opaque
 * branded or invariant-protected properties are listed separately for source audit.
 * --without-ancestors exercises the shared empty-ancestor encoding; --profile-dir
 * saves allocation profiles for per-recipient attribution before and after audience lookup.
 * --ancestor-depth 16 --advance-clock --prepared-events reproduces an active deep
 * subagent chain with tool-call/result messages. Each publication prepares real rows;
 * advancing time is synchronized by publication sequence across both revisions.
 * This measures owner work only, not whole-Gateway latency or throughput.
 */
import assert from "node:assert/strict";
import crypto, { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
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
    "baseline-ancestor-source": { type: "string" },
    publications: { type: "string", default: "500" },
    pairs: { type: "string", default: "5" },
    clients: { type: "string", default: "66" },
    "sampling-interval": { type: "string", default: "16384" },
    "state-root": { type: "string", default: ".local/session-event-field-order" },
    "reuse-envelope": { type: "boolean", default: false },
    corpus: { type: "string" },
    "client-reads": { type: "boolean", default: false },
    "without-ancestors": { type: "boolean", default: false },
    "profile-dir": { type: "string" },
    "ancestor-depth": { type: "string", default: "2" },
    "advance-clock": { type: "boolean", default: false },
    "prepared-events": { type: "boolean", default: false },
  },
});
assert(!values["client-reads"] || values.corpus, "--client-reads requires --corpus");

type ClientReadTrace = { active: boolean; paths: Set<string>; opaque: Set<string> };

function observeClientReads(client: GatewayWsClient, trace: ClientReadTrace): GatewayWsClient {
  const proxies = new WeakMap<object, object>();
  const observe = <T extends object>(value: T, readPrefix: string): T => {
    const cached = proxies.get(value);
    if (cached) {
      // Each proxy wraps this exact target; preserve aliases and registry identity.
      return cached as T;
    }
    const proxy = new Proxy(value, {
      get(target, property, receiver) {
        const readPath = `${readPrefix}.${String(property)}`;
        if (trace.active) {
          trace.paths.add(`get:${readPath}`);
        }
        const field: unknown = Reflect.get(target, property, receiver);
        if (field === null || typeof field !== "object") {
          return field;
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        const prototype: unknown = Reflect.getPrototypeOf(field);
        if (
          (descriptor?.configurable === false && descriptor.writable === false) ||
          (!Array.isArray(field) && prototype !== Object.prototype && prototype !== null)
        ) {
          if (trace.active) {
            trace.opaque.add(readPath);
          }
          return field;
        }
        return observe(field, readPath);
      },
      has(target, property) {
        if (trace.active) {
          trace.paths.add(`has:${readPrefix}.${String(property)}`);
        }
        return Reflect.has(target, property);
      },
      getOwnPropertyDescriptor(target, property) {
        if (trace.active) {
          trace.paths.add(`descriptor:${readPrefix}.${String(property)}`);
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      ownKeys(target) {
        if (trace.active) {
          trace.paths.add(`keys:${readPrefix}`);
        }
        return Reflect.ownKeys(target);
      },
    });
    proxies.set(value, proxy);
    return proxy;
  };
  return observe(client, "client");
}

const integer = (
  key: "publications" | "pairs" | "clients" | "sampling-interval" | "ancestor-depth",
  min: number,
) => parseStrictIntegerOption({ raw: values[key], fallback: min, min, label: `--${key}` });
const publications = integer("publications", 1);
const pairs = integer("pairs", 1);
const clientCount = integer("clients", 1);
const samplingInterval = integer("sampling-interval", 1024);
const ancestorDepth = values["without-ancestors"] ? 0 : integer("ancestor-depth", 0);
assert(ancestorDepth <= 64, "--ancestor-depth must be at most 64");
const ownerUrl = new URL("../../src/gateway/session-event-projection.ts", import.meta.url);
const baselineUrl = `${ownerUrl.href}?field-order-baseline`;
const candidateUrl = `${ownerUrl.href}?field-order-candidate`;
assert(values["baseline-source"], "--baseline-source is required");
const baselineSource = readFileSync(values["baseline-source"], "utf8");
const candidateSource = readFileSync(ownerUrl, "utf8");
const connectionUrl = new URL("../../src/gateway/server-connection-state.ts", import.meta.url);
const ancestorUrl = new URL("../../src/gateway/session-ancestor-references.ts", import.meta.url);
const baselineAncestorUrl = `${ancestorUrl.href}?field-order-baseline`;
const baselineAncestorSource =
  values["baseline-ancestor-source"] && readFileSync(values["baseline-ancestor-source"], "utf8");
const candidateAncestorSource = readFileSync(ancestorUrl, "utf8");
let baselineAncestorLoaded = false;
const baselineConnectionUrl = `${connectionUrl.href}?field-order-baseline`;
let baselineLoaded = false;
let candidateLoaded = false;
const sourceHash = (source: string) => createHash("sha256").update(source).digest("hex");
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      baselineAncestorSource !== undefined &&
      (context.parentURL === baselineConnectionUrl || context.parentURL === baselineUrl) &&
      specifier === "./session-ancestor-references.js"
    ) {
      return { url: baselineAncestorUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === baselineUrl) {
      baselineLoaded = true;
      return { format: "module-typescript", source: baselineSource, shortCircuit: true };
    }
    if (url === candidateUrl) {
      candidateLoaded = true;
      return { format: "module-typescript", source: candidateSource, shortCircuit: true };
    }
    if (url === baselineAncestorUrl && baselineAncestorSource !== undefined) {
      baselineAncestorLoaded = true;
      return { format: "module-typescript", source: baselineAncestorSource, shortCircuit: true };
    }
    if (url === baselineConnectionUrl) {
      return {
        format: "module-typescript",
        source: readFileSync(connectionUrl, "utf8"),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
const baseline: typeof import("../../src/gateway/session-event-projection.js") = await import(
  baselineUrl
);
assert(baselineLoaded, "baseline owner was not loaded");
const { prepareSessionEventProjection }: typeof baseline = await import(candidateUrl);
assert(candidateLoaded, "candidate owner was not loaded");
const { createGatewayConnectionState } =
  await import("../../src/gateway/server-connection-state.js");
const baselineConnection: typeof import("../../src/gateway/server-connection-state.js") =
  baselineAncestorSource === undefined
    ? { createGatewayConnectionState }
    : await import(baselineConnectionUrl);
assert(
  baselineAncestorSource === undefined || baselineAncestorLoaded,
  "baseline ancestor owner was not loaded",
);
hook.deregister();
const { prepareGatewayRecipientProfile } = await import("../../src/gateway/expected-profile.js");
const { createSessionRowProjection } = await import("../../src/gateway/session-row-projection.js");
const { replaceSessionEntrySync } = await import("../../src/config/sessions/session-accessor.js");
const { ensureProfileForEmail } = await import("../../src/state/user-profiles.js");
const { setUserProfileRole } = await import("../../src/state/user-profile-writes.worker.js");
const { createTestGatewayScheduler } =
  await import("../../src/test-utils/gateway-scheduler-clock.js");
const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { buildGatewaySessionSnapshot } = await import("../../src/gateway/session-event-payload.js");

const { withPreparedEventRow } = await import("../../src/gateway/session-event-prepared-row.js");
const { subagentRuns } =
  await import("../../src/agents/subagents/registry/subagent-registry-memory.js");
const { claimAgentRunContext, releaseAgentRunContext } =
  await import("../../src/infra/agent-run-registry.js");
const runClaims: { runId: string; claim: string }[] = [];

const temporaryRoot = path.resolve(values["state-root"]);
mkdirSync(temporaryRoot, { recursive: true });
const previousTmp = process.env.TMPDIR;
process.env.TMPDIR = temporaryRoot;
const now = Date.now;
Date.now = () => 1_000_000 + (values["advance-clock"] ? publicationSequence * 10 : 0);
const originalRandomUUID = crypto.randomUUID;
let publicationSequence = 0;
const corpusPath = values.corpus && path.resolve(values.corpus);
let corpusFrames = 0;
const corpusDigest = createHash("sha256");
if (corpusPath) {
  mkdirSync(path.dirname(corpusPath), { recursive: true });
  writeFileSync(corpusPath, "");
}
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
    const ancestorKeys = Array.from({ length: ancestorDepth }, (_, index) =>
      index === 0
        ? "agent:main:field-order-parent"
        : index === 1
          ? "agent:main:field-order-ancestor"
          : `agent:main:field-order-ancestor-${index}`,
    );
    for (const [index, key] of ancestorKeys.entries()) {
      const parentSessionKey = ancestorKeys[index + 1];
      const visibility = index % 2 === 0 ? "draft" : "shared";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        {
          sessionId: key,
          label: key,
          updatedAt: 1,
          visibility,
          parentSessionKey,
          createdActor: { type: "human", source: "profile", id: profiles[0]!.id },
        },
      );
    }
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
        parentSessionKey: ancestorKeys[0],
        createdActor: { type: "human", source: "profile", id: profiles[0]!.id },
      },
    );
    if (values["advance-clock"]) {
      for (const [index, childSessionKey] of [root, ...ancestorKeys].entries()) {
        const runId = `field-order-run-${index}`;
        const entry = {
          runId,
          childSessionKey,
          requesterSessionKey: ancestorKeys[index] ?? childSessionKey,
          requesterDisplayKey: "main",
          task: "Synthetic Code Mode burst",
          cleanup: "keep",
          createdAt: 900_000,
          execution: { status: "running", startedAt: 900_000 },
        } satisfies import("../../src/agents/subagents/registry/subagent-registry.types.js").SubagentRunRecord;
        subagentRuns.set(runId, entry);
        const claim = claimAgentRunContext(
          runId,
          { sessionKey: childSessionKey },
          { trackOwner: true },
        );
        assert(claim, "active subagent fixture claim failed");
        runClaims.push({ runId, claim });
        subagentRuns.commitOwnership(entry);
      }
    }
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const record = projection.describe({ key: root, agentId: "main" });
    assert(record);
    const ancestors = projection.ancestorRows(record);
    assert.equal(ancestors?.length, ancestorDepth, "fixture ancestor chain is incomplete");
    const snapshot = buildGatewaySessionSnapshot({
      sessionRow: projection.present(record),
      agentId: "main",
    });
    // Only publication entropy is fixed; profile/catalog creation above keeps normal identities.
    crypto.randomUUID = () =>
      `00000000-0000-4000-8000-${publicationSequence.toString(16).padStart(12, "0")}`;
    syncBuiltinESMExports();
    const results: unknown[] = [];
    for (const history of ["divergent", "aligned"] as const) {
      const variants = [
        {
          name: "base",
          prepare: baseline.prepareSessionEventProjection,
          createConnection: baselineConnection.createGatewayConnectionState,
        },
        {
          name: "candidate",
          prepare: prepareSessionEventProjection,
          createConnection: createGatewayConnectionState,
        },
      ].map(({ name, prepare, createConnection }) => {
        const connection = createConnection({
          cfg,
          scheduler: createTestGatewayScheduler(),
          bootId: `field-order-${name}`,
        });
        const detach = connection.attachSessionRowProjection(projection);
        const readTrace: ClientReadTrace = { active: false, paths: new Set(), opaque: new Set() };
        let sequence = 0;
        const preparePublication = (
          read?: Parameters<typeof prepare>[1],
          preparedAncestors?: typeof ancestors,
        ) =>
          prepare(projection, read, {
            ancestors: read ? preparedAncestors : ancestors,
            encodeMessage: true,
            ...(values["reuse-envelope"] ? { reuseEnvelope: true } : {}),
            omitMessage: (client) =>
              client.connect.caps?.includes("roster-message-bodies-optional") === true &&
              client.includeSessionMessageBodies === false &&
              !connection.sessionMessageSubscribers.get(root).has(client.connId ?? ""),
          });
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
          const fixtureClient: GatewayWsClient = {
            connId: `${name}-${index}`,
            socket,
            usesSharedGatewayAuth: false,
            includeSessionMessageBodies: index % 2 === 0,
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
              caps:
                Math.floor(index / profiles.length) % 3 === 0
                  ? []
                  : [
                      "session-row-deltas",
                      ...(Math.floor(index / profiles.length) % 3 === 2
                        ? ["session-event-field-refs"]
                        : []),
                      "roster-message-bodies-optional",
                    ],
            },
          };
          const client = values["client-reads"]
            ? observeClientReads(fixtureClient, readTrace)
            : fixtureClient;
          prepareGatewayRecipientProfile(client);
          connection.clients.add(client);
          connection.sessionEventSubscribers.subscribe(client.connId);
          if (index % 5 === 0) {
            connection.sessionMessageSubscribers.subscribe(client.connId, root);
          }
          return { client, received };
        });
        const payload = { sessionKey: root, agentId: "main", reason: "send", ...snapshot };
        const publishTo = async (event: string, source: typeof payload, connIds?: Set<string>) => {
          publicationSequence = ++sequence;
          const broadcast: Parameters<typeof withPreparedEventRow>[2] = (
            read,
            preparedAncestors,
          ) => {
            const current = read?.describe({ key: root, agentId: "main" });
            const currentSource =
              current && read
                ? {
                    ...source,
                    ...buildGatewaySessionSnapshot({
                      sessionRow: read.present(current),
                      agentId: "main",
                    }),
                  }
                : source;
            const opts = { prepareSessionProjection: preparePublication(read, preparedAncestors) };
            if (connIds) {
              connection.broadcastToConnIds(event, currentSource, connIds, opts);
            } else {
              connection.broadcast(event, currentSource, opts);
            }
          };
          if (values["prepared-events"]) {
            await withPreparedEventRow(projection, { key: root, agentId: "main" }, broadcast);
          } else {
            broadcast();
          }
        };
        return {
          name,
          connection,
          detach,
          peers,
          readTrace,
          async prime() {
            if (history !== "divergent") {
              return;
            }
            for (const [index, { client, received }] of peers.entries()) {
              for (let prior = 0; prior <= Math.floor(index / profiles.length); prior++) {
                await publishTo(
                  "sessions.changed",
                  { sessionKey: root, agentId: "main", reason: "send" },
                  new Set([client.connId]),
                );
              }
              assert(received.count > 0, "recipient priming failed");
            }
          },
          async publish(
            event = values["prepared-events"] ? "session.message" : "sessions.changed",
            source: typeof payload & { message?: unknown } = values["prepared-events"]
              ? {
                  ...payload,
                  message:
                    sequence % 2 === 0
                      ? {
                          role: "assistant",
                          content: [
                            {
                              type: "toolCall",
                              id: `tool-${sequence}`,
                              name: "code",
                              arguments: { code: "return await tools.fixture({limit: 10});" },
                            },
                          ],
                        }
                      : {
                          role: "toolResult",
                          toolCallId: `tool-${sequence - 1}`,
                          toolName: "code",
                          content: [
                            {
                              type: "text",
                              text: "Synthetic tool result: " + "fixture output ".repeat(40),
                            },
                          ],
                          isError: false,
                        },
                }
              : payload,
            targeted = false,
          ) {
            await publishTo(
              event,
              source,
              targeted
                ? new Set(
                    peers.filter((_, index) => index % 2 === 0).map(({ client }) => client.connId),
                  )
                : undefined,
            );
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
          await variant.publish();
          if ((index + 1) % 100 === 0) {
            await yieldToLoop();
          }
        }
      };
      const inspector = new Session();
      const measurements: unknown[] = [];
      try {
        for (const variant of variants) {
          await variant.prime();
        }
        if (corpusPath) {
          for (let sample = 0; sample < 8; sample++) {
            const event = sample % 3 === 0 ? "sessions.changed" : "session.message";
            const source = {
              sessionKey: root,
              agentId: "main",
              reason: sample === 3 ? "activity-summary" : "send",
              ...(event === "session.message"
                ? {
                    message:
                      sample === 5
                        ? undefined
                        : values["prepared-events"] && sample === 7
                          ? {
                              role: "toolResult",
                              toolCallId: "tool-6",
                              toolName: "code",
                              content: [{ type: "text", text: "Synthetic Code Mode tool result" }],
                              isError: false,
                            }
                          : {
                              role: "assistant",
                              content: [
                                {
                                  type: "text",
                                  text: `Synthetic broadcast ${sample}: "🦞"\\\n\ud800`,
                                },
                                {
                                  type: "toolCall",
                                  id: `tool-${sample}`,
                                  name: "fixture",
                                  arguments: { sample },
                                },
                              ],
                            },
                  }
                : {}),
              ...snapshot,
              ["__proto__"]: { synthetic: true },
            };
            const previousCounts = variants[0]!.peers.map(({ received }) => received.count);
            for (const variant of variants) {
              if (sample === 4) {
                for (const peer of variant.peers) {
                  peer.client.includeSessionMessageBodies =
                    !peer.client.includeSessionMessageBodies;
                }
              }
              variant.readTrace.active = values["client-reads"];
              try {
                await variant.publish(event, source, sample === 2);
              } finally {
                variant.readTrace.active = false;
              }
            }
            verify();
            const records = variants[0]!.peers.flatMap((peer, index) => {
              if (peer.received.count === previousCounts[index]) {
                return [];
              }
              const base = peer.received.last!.toString();
              const candidate = variants[1]!.peers[index]!.received.last!.toString();
              const baseSha256 = sourceHash(base);
              const candidateSha256 = sourceHash(candidate);
              assert.equal(baseSha256, candidateSha256);
              corpusDigest.update(base);
              corpusFrames++;
              return [
                {
                  history,
                  sample,
                  event,
                  recipient: index,
                  caps: peer.client.connect.caps,
                  baseSha256,
                  candidateSha256,
                  base,
                  candidate,
                },
              ];
            });
            appendFileSync(
              corpusPath,
              `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
            );
          }
        }
        if (values["client-reads"]) {
          results.push({
            history,
            clientReads: Object.fromEntries(
              variants.map(({ name, readTrace }) => [
                name,
                {
                  paths: [...readTrace.paths].toSorted(),
                  opaque: [...readTrace.opaque].toSorted(),
                },
              ]),
            ),
          });
          continue;
        }
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
            await variant.publish();
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
              if (profile && values["profile-dir"]) {
                mkdirSync(values["profile-dir"], { recursive: true });
                writeFileSync(
                  path.join(values["profile-dir"], `${history}-${pair}-${variant.name}.json`),
                  JSON.stringify(profile),
                );
              }
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
          reuseEnvelope: values["reuse-envelope"],
          withoutAncestors: values["without-ancestors"],
          ancestorDepth,
          advanceClock: values["advance-clock"],
          preparedEvents: values["prepared-events"],
          clientReadInstrumentation: values["client-reads"],
          ...(corpusPath
            ? { corpusPath, corpusFrames, corpusSha256: corpusDigest.digest("hex") }
            : {}),
          sourceSha256: {
            base: sourceHash(baselineSource),
            candidate: sourceHash(candidateSource),
            ancestorBase: sourceHash(baselineAncestorSource ?? candidateAncestorSource),
            ancestorCandidate: sourceHash(candidateAncestorSource),
          },
          results,
        },
        null,
        2,
      ),
    );
  });
} finally {
  for (const { runId, claim } of runClaims) {
    releaseAgentRunContext(runId, claim);
    subagentRuns.delete(runId);
  }
  crypto.randomUUID = originalRandomUUID;
  syncBuiltinESMExports();
  Date.now = now;
  if (previousTmp === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmp;
  }
}
