// Real Gateway transport plus the Control UI's session owner, with optional loopback model turns.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { GatewaySessionRowEvents } from "../../ui/src/api/gateway-session-row-events.ts";
import type {
  GatewayBrowserClient,
  GatewayEventFrame,
  GatewayHelloOk,
} from "../../ui/src/api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../ui/src/api/types.ts";
import type {
  SessionCapability,
  SessionGateway,
  SessionListScope,
} from "../../ui/src/lib/sessions/session-capability.ts";
import { buildSessionListParams } from "../../ui/src/lib/sessions/session-requests.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { readBody } from "../e2e/lib/mock-openai-http.mjs";
import { BASE_GATEWAY_BENCH_CONFIG } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    port: { type: "string", default: "41471" },
    sessions: { type: "string", default: "270" },
    duration: { type: "string", default: "135" },
    "interval-ms": { type: "string", default: "1000" },
    "start-at": { type: "string" },
    "session-owner": { type: "string" },
    "model-turns": { type: "string", default: "0" },
    "mock-port": { type: "string", default: "41474" },
    "membership-churn": { type: "boolean", default: false },
  },
});
const integer = (raw: string, label: string, min: number) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
const port = integer(values.port, "--port", 40000);
assert(port <= 65535);
const modelTurns = integer(values["model-turns"], "--model-turns", 0);
const mockPort = integer(values["mock-port"], "--mock-port", 40000);
assert(mockPort <= 65535 && mockPort !== port);
const count = integer(values.sessions, "--sessions", 20);
const durationMs = integer(values.duration, "--duration", 1) * 1000;
const intervalMs = integer(values["interval-ms"], "--interval-ms", 100);
const root = path.resolve(values["state-dir"]);
mkdirSync(root); // A run never adopts existing state.
mkdirSync(path.join(root, "tmp"));
const configPath = path.join(root, "openclaw.json");
const config = {
  ...BASE_GATEWAY_BENCH_CONFIG,
  gateway: {
    ...BASE_GATEWAY_BENCH_CONFIG.gateway,
    controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
  },
  agents: {
    defaults: { model: { primary: "openai/gpt-5.6-luna" } },
    entries: { main: { workspace: path.join(root, "workspace") } },
  },
  plugins: { enabled: false },
  cron: { enabled: false },
};
if (modelTurns) {
  applyMockOpenAiModelConfig(config, {
    mockPort,
    modelRef: "openai/gpt-5.6-luna",
    utilityModelRef: "openai/gpt-5.6-sol",
  });
  Object.assign(config.plugins, {
    enabled: true,
    allow: ["openai"],
    slots: { memory: "none" },
    load: { paths: [path.resolve("extensions/openai")] },
  });
  process.env.OPENAI_API_KEY = "synthetic-loopback-only";
}
writeFileSync(configPath, JSON.stringify(config));
Object.assign(process.env, {
  OPENCLAW_HOME: root,
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_CONFIG_PATH: configPath,
  TMPDIR: path.join(root, "tmp"),
});
const { startGatewayServer } = await import("../../src/gateway/server.js");
const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
const owner = (
  values["session-owner"]
    ? await import(pathToFileURL(path.resolve(values["session-owner"])).href)
    : {
        ...(await import("../../ui/src/lib/sessions/index.ts")),
        GatewaySessionRowEvents,
      }
) as {
  createSessionCapability(
    gateway: SessionGateway,
    selection: { state: { selectedId: string }; subscribe(): () => void },
  ): SessionCapability;
  GatewaySessionRowEvents: typeof GatewaySessionRowEvents;
};
const eventListeners = new Set<(event: GatewayEventFrame) => void>();
const decoder = new owner.GatewaySessionRowEvents();
const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
let phase = "setup";
let latestEvent: Record<string, unknown> | null = null;
let eventCount = 0;
const pendingPatches = new Set<string>();
const modelEvents: Array<Record<string, unknown>> = [];
let modelRequests = 0;
const modelOutcomes: unknown[] = [];
let eventBytes = 0;
let decodeGaps = 0;
const eventReasons: Record<string, number> = {};
const calls: Array<Record<string, unknown>> = [];
const failures: string[] = [];
let capability: SessionCapability | undefined;
const observations: Array<{ dispose(): void }> = [];
const peer = createGatewayWsClient({
  url: `ws://127.0.0.1:${port}`,
  origin: `http://127.0.0.1:${port}`,
  onEvent(event) {
    if (
      event.event === "connect.challenge" &&
      isRecord(event.payload) &&
      typeof event.payload.nonce === "string" &&
      typeof event.payload.ts === "number"
    ) {
      challenge.resolve({ nonce: event.payload.nonce, ts: event.payload.ts });
    }
    const projected = decoder.project(event);
    if (projected.missingBaseline) {
      decodeGaps++;
      return;
    }
    if (event.event === "sessions.changed") {
      const payload = isRecord(projected.event.payload) ? projected.event.payload : {};
      latestEvent = {
        at: Date.now(),
        reason: payload.reason,
        sessionKey: payload.sessionKey,
        revision: payload.revision,
        event: event.event,
      };
      const row = isRecord(payload.session) ? payload.session : {};
      if (isRecord(row.agentStatus)) {
        pendingPatches.delete(JSON.stringify([payload.sessionKey, row.agentStatus.note]));
      }
      if (phase === "model-correctness") {
        modelEvents.push({ ...latestEvent, phase: payload.phase });
      }
      if (phase === "activity") {
        eventCount++;
        eventBytes += Buffer.byteLength(JSON.stringify(event));
        const reason = String(payload.reason);
        eventReasons[reason] = (eventReasons[reason] ?? 0) + 1;
      }
    }
    for (const listener of eventListeners) {
      listener(projected.event);
    }
  },
});
async function rpc(method: string, params: unknown) {
  const result = await peer.request(method, params, 60_000);
  assert(result.ok, `${method}: ${JSON.stringify(result.error)}`);
  return result.payload;
}
const mock = modelTurns
  ? createServer((req, res) => {
      void (async () => {
        assert.equal(req.url, "/v1/responses");
        await readBody(req);
        modelRequests++;
        const item = {
          type: "message",
          id: `msg_${modelRequests}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Synthetic roster answer.", annotations: [] }],
        };
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        send({
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        });
        await delay(250);
        send({
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: "Synthetic roster answer.",
        });
        send({ type: "response.output_item.done", output_index: 0, item });
        send({
          type: "response.completed",
          response: {
            id: `resp_${modelRequests}`,
            status: "completed",
            output: [item],
            usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
          },
        });
        res.end("data: [DONE]\n\n");
      })().catch((error: unknown) => {
        failures.push(String(error));
        res.destroy();
      });
    })
  : null;
try {
  if (mock) {
    await new Promise<void>((resolve, reject) => {
      mock.once("error", reject);
      mock.listen(mockPort, "127.0.0.1", resolve);
    });
  }
  await peer.waitOpen();
  const timeout = setTimeout(
    () => challenge.reject(new Error("connect challenge timeout")),
    12_000,
  );
  const { nonce, ts } = await challenge.promise.finally(() => clearTimeout(timeout));
  const keys = generateKeyPairSync("ed25519");
  const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
  const identity = {
    id: "openclaw-control-ui",
    version: "dev",
    platform: "web",
    mode: "webchat",
    instanceId: "synthetic-roster",
  };
  const scopes = ["operator.admin"];
  const signed = buildDeviceAuthPayloadV3({
    deviceId,
    clientId: identity.id,
    clientMode: identity.mode,
    platform: identity.platform,
    role: "operator",
    scopes,
    signedAtMs: ts,
    nonce,
  });
  const hello = (await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: identity,
    role: "operator",
    scopes,
    device: {
      id: deviceId,
      publicKey,
      signedAt: ts,
      nonce,
      signature: signEd25519Payload(
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
        signed,
      ),
    },
    caps: ["session-row-deltas", "session-event-field-refs"],
  })) as GatewayHelloOk;
  const self = await rpc("users.self", {});
  assert(isRecord(self) && isRecord(self.profile) && typeof self.profile.id === "string");
  const profileId = self.profile.id;
  await rpc("sessions.create", {
    key: "agent:main:main",
    visibility: "shared",
    displayName: "Synthetic parent",
  });
  const sessionKeys = Array.from({ length: count }, (_, i) => `agent:main:roster-${i}`);
  const sessionIds = new Map<string, string>();
  for (const [index, key] of sessionKeys.entries()) {
    const created = await rpc("sessions.create", {
      key,
      visibility: "shared",
      displayName: `Synthetic session ${index}`,
      ...(index > count - 11 ? { parentSessionKey: sessionKeys[0] } : {}),
    });
    assert(isRecord(created) && typeof created.sessionId === "string");
    sessionIds.set(key, created.sessionId);
  }
  for (const key of sessionKeys.slice(0, 10)) {
    await rpc("sessions.patch", { key, statusNote: "Synthetic warm row", ttlMinutes: 5 });
  }
  console.log(JSON.stringify({ phase: "fixture-ready", sessions: count + 1 }));
  const request = async (method: string, params?: Record<string, unknown>) => {
    const startedAt = Date.now();
    const call =
      method === "sessions.list"
        ? {
            phase,
            startedAt,
            params,
            precedingEvent: latestEvent,
            hasBase: typeof params?.ifRowsRevision === "string" && params.ifRowsRevision.length > 0,
            caller: params?.spawnedBy
              ? "compact-children"
              : params?.ownerId
                ? "sidebar-owner"
                : params?.involvingMe
                  ? "sidebar-involving"
                  : params?.includeOwnerSessionCounts
                    ? "owner-counts"
                    : params?.source === "sidebar"
                      ? "sidebar-general"
                      : "chat-pane",
          }
        : null;
    try {
      const response = await rpc(method, params);
      if (call) {
        calls.push({
          ...call,
          ms: Date.now() - startedAt,
          bytes: Buffer.byteLength(JSON.stringify(response)),
          responseKind:
            isRecord(response) && response.rowsUnchanged
              ? "unchanged"
              : isRecord(response) && response.rowsDelta
                ? "delta"
                : "full",
        });
      }
      return response;
    } catch (error) {
      failures.push(String(error));
      throw error;
    }
  };
  const gatewayListeners = new Set<(snapshot: SessionGateway["snapshot"]) => void>();
  const gateway: SessionGateway = {
    snapshot: {
      client: { request } as GatewayBrowserClient,
      phase: "connected",
      hello,
      assistantAgentId: "main",
      sessionKey: sessionKeys[0],
      selfUser: { id: profileId },
    },
    subscribe: (listener) => {
      gatewayListeners.add(listener);
      return () => {
        gatewayListeners.delete(listener);
      };
    },
    subscribeEvents: (listener) => {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
  };
  capability = owner.createSessionCapability(gateway, {
    state: { selectedId: "main" },
    subscribe: () => () => {},
  });
  for (const listener of gatewayListeners) {
    listener(gateway.snapshot);
  }
  const common = {
    source: "sidebar",
    agentId: "main",
    rowMode: "sidebar",
    limit: 200,
    ownerFirst: true,
    includeDerivedTitles: true,
    includeLastMessage: true,
  } as const;
  const queries: Array<{ name: string; query: SessionListScope }> = [
    { name: "sidebar-general", query: common },
    {
      name: "sidebar-owner",
      query: { ...common, ownerFirst: undefined, agentId: undefined, ownerId: profileId },
    },
    {
      name: "sidebar-involving",
      query: { ...common, ownerFirst: undefined, involvingMe: true },
    },
    {
      name: "compact-children",
      query: {
        ...common,
        source: "chat-pane",
        rowMode: "compact",
        ownerFirst: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        spawnedBy: sessionKeys[0],
      },
    },
  ];
  for (const { query } of queries) {
    const observation = capability.observeList(query, () => {});
    observations.push(observation);
    await observation.refresh();
    assert(
      (capability.listSnapshot(query).result?.sessions.length ?? 0) > 0,
      "every observed query must contain fixture rows",
    );
  }
  // The primary chat roster is a separate consumer, and must share the same owner.
  await capability.refresh({ ...common, force: true });
  await delay(1000);
  console.log(JSON.stringify({ phase: "observers-ready", calls: calls.length }));
  if (values["start-at"]) {
    const startAt = integer(values["start-at"], "--start-at", 1);
    assert(startAt > Date.now(), "pair start deadline must follow Gateway preparation");
    await delay(startAt - Date.now());
  }
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const cpu = process.cpuUsage();
  const started = performance.now();
  phase = "activity";
  const operations = Math.floor(durationMs / intervalMs);
  for (let round = 0; round < operations; round++) {
    await delay(Math.max(0, started + round * intervalMs - performance.now()));
    const key = sessionKeys[round % 10]!;
    pendingPatches.add(JSON.stringify([key, `Synthetic phase ${round}`]));
    await rpc("sessions.patch", {
      key,
      statusNote: `Synthetic phase ${round}`,
      ttlMinutes: 5,
      ...(round % 3 === 0 ? { label: `Synthetic label ${round}` } : {}),
    });
    if (values["membership-churn"] && round > 0 && round % 30 === 0) {
      await rpc("sessions.create", {
        key: `agent:main:roster-new-${round}`,
        visibility: "shared",
        displayName: `Synthetic new session ${round}`,
      });
      const archivedKey = sessionKeys[count - 15 + ((round / 30) % 4)]!;
      await rpc("sessions.patch", {
        key: archivedKey,
        expectedSessionId: sessionIds.get(archivedKey),
        archived: true,
      });
    }
  }
  await delay(Math.max(0, started + durationMs - performance.now()));
  console.log(JSON.stringify({ phase: "activity-complete", eventCount }));
  phase = "drain";
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  loop.disable();
  if (modelTurns) {
    phase = "model-correctness";
    for (let turn = 0; turn < modelTurns; turn++) {
      const key = sessionKeys[turn % 10]!;
      await rpc("sessions.patch", {
        key,
        model: turn % 2 ? "openai/gpt-5.6-sol" : "openai/gpt-5.6-luna",
      });
      const runId = randomUUID();
      await rpc("agent", {
        sessionKey: key,
        message: "Reply with one synthetic acknowledgement.",
        deliver: false,
        idempotencyKey: runId,
      });
      const outcome = await rpc("agent.wait", { runId, timeoutMs: 60_000 });
      modelOutcomes.push(outcome);
      assert(
        isRecord(outcome) && outcome.status === "ok",
        `synthetic turn failed: ${JSON.stringify(outcome)}`,
      );
    }
  }
  await delay(20_000); // Allow one paced membership refresh to settle before comparing authority.
  const correctness: Array<Record<string, unknown>> = [];
  phase = "verification";
  const compareRows = async (
    name: string,
    held: SessionsListResult | null,
    query: SessionListScope,
  ) => {
    assert(held, `${name} must retain a list result`);
    const authoritative = (await rpc(
      "sessions.list",
      buildSessionListParams(query),
    )) as SessionsListResult;
    // Sidebar rows omit model and terminal status, even for explicit model overrides.
    const fullRows = (await rpc("sessions.list", {
      ...buildSessionListParams(query),
      rowMode: undefined,
    })) as SessionsListResult;
    const fullByKey = new Map(fullRows.sessions.map((row) => [row.key, row]));
    const facts = (row: GatewaySessionRow, defaults: SessionsListResult["defaults"]) => ({
      key: row.key,
      label: row.label,
      status: row.status,
      hasActiveRun: row.hasActiveRun === true,
      modelProvider: row.modelProvider ?? defaults.modelProvider,
      model: row.model ?? defaults.model,
      note: row.agentStatus?.note,
    });
    const actual = new Map(held.sessions.map((row) => [row.key, facts(row, held.defaults)]));
    const expected = new Map(
      authoritative.sessions.map((row) => {
        const full = fullByKey.get(row.key);
        assert(full, `full authority must include ${name} row ${row.key}`);
        return [row.key, facts(full, fullRows.defaults)];
      }),
    );
    const rowKeys = [...new Set([...actual.keys(), ...expected.keys()])].toSorted();
    const mismatches = rowKeys
      .filter((key) => JSON.stringify(actual.get(key)) !== JSON.stringify(expected.get(key)))
      .map((key) => ({ key, actual: actual.get(key), expected: expected.get(key) }));
    correctness.push({
      name,
      held: actual.size,
      authoritative: expected.size,
      equal: mismatches.length === 0,
      mismatches,
    });
  };
  for (const { name, query } of queries) {
    const snapshot = capability.listSnapshot(query);
    assert.equal(snapshot.error, null, `${name} observer error`);
    await compareRows(name, snapshot.result, query);
  }
  await compareRows("primary", capability.state.result, common);
  const measuredCalls = calls.filter((call) => call.phase === "activity");
  const report = {
    boundary:
      "real Gateway + real Control UI session capability over WebSocket; no browser renderer",
    sessionOwner: values["session-owner"] ?? "current source",
    count,
    operations,
    elapsedMs,
    membershipChurn: values["membership-churn"],
    eventCount,
    missingPatches: [...pendingPatches],
    eventBytes,
    eventReasons,
    decodeGaps,
    callsPerMinute: (measuredCalls.length * 60_000) / elapsedMs,
    listCalls: measuredCalls.length,
    listBytes: measuredCalls.reduce((sum, call) => sum + Number(call.bytes), 0),
    listBytesPerMinute:
      (measuredCalls.reduce((sum, call) => sum + Number(call.bytes), 0) * 60_000) / elapsedMs,
    cpuMs: (used.user + used.system) / 1000,
    nodeEventLoopP95Ms: loop.percentile(95) / 1e6,
    nodeEventLoopMaxMs: loop.max / 1e6,
    correctness,
    failures,
    calls,
    modelTurns,
    modelRequests,
    modelOutcomes,
    modelEvents,
    gaps: [
      "No browser DOM rendering or native Long Task blocking measurement",
      ...(modelTurns ? [] : ["No model turns: running/settled lifecycles are not exercised"]),
    ],
  };
  writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, calls: undefined }));
  if (modelTurns) {
    assert(modelRequests >= modelTurns, "each synthetic turn must reach the loopback provider");
    assert(
      modelEvents.filter((event) => event.phase === "start").length >= modelTurns,
      "missing run-start observations",
    );
    assert(
      modelEvents.filter((event) => event.phase === "end").length >= modelTurns,
      "missing run-settled observations",
    );
  }
  assert.equal(
    pendingPatches.size,
    0,
    "every workload patch must be observed through real session events",
  );
  assert.equal(decodeGaps, 0, "real event row baselines must remain valid");
  assert.equal(failures.length, 0, failures.join("\n"));
  assert(
    correctness.every((item) => item.equal),
    "final row membership or facts differ from authority",
  );
} finally {
  for (const observation of observations) {
    observation.dispose();
  }
  capability?.dispose();
  peer.close();
  await server.close();
  if (mock?.listening) {
    await new Promise<void>((resolve, reject) => {
      mock.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
