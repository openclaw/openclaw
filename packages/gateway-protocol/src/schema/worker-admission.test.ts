import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../client-info.js";
import { FAILOVER_REASONS } from "../failover-reasons.js";
import {
  type WorkerAdmissionHandshake,
  WorkerAdmissionResponseFrameSchema as AdmissionResponse,
  WorkerHeartbeatRequestFrameSchema as HeartbeatRequest,
  WorkerHeartbeatResponseFrameSchema as HeartbeatResponse,
  WorkerLiveEventRequestFrameSchema as LiveRequest,
  WorkerLiveEventResponseFrameSchema as LiveResponse,
  WorkerProtocolCloseReasonSchema as CloseReason,
  WorkerTranscriptCommitRequestFrameSchema as CommitRequest,
  WorkerTranscriptCommitResponseFrameSchema as CommitResponse,
  WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES as MAX_REPLAY_BYTES,
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
  WORKER_TRANSCRIPT_MAX_JSON_DEPTH,
  validateWorkerAdmissionHandshake as validateHandshake,
  validateWorkerConnectRequestFrame as validateConnect,
  validateWorkerHeartbeatParams as validateHeartbeat,
  validateWorkerLiveEventParams as validateLive,
  validateWorkerTranscriptCommitParams as validateCommit,
} from "../index.js";
import { isWorkerTranscriptFrameWithinBudget } from "../worker-transcript-budget.js";
import { WorkerGatewayToolResultSchema as GatewayToolResult } from "./worker-gateway-tool.js";
import {
  WORKER_INFERENCE_MAX_OUTPUT_TOKENS,
  validateWorkerInferenceEventFrame as validateInferenceEvent,
  validateWorkerInferenceStartParams as validateInferenceStart,
  validateWorkerInferenceTerminalFrame as validateInferenceTerminal,
} from "./worker-inference.js";
import { WORKER_PROTOCOL_MAX_PAYLOAD_BYTES as MAX_PAYLOAD_BYTES } from "./worker-protocol-primitives.js";

const bundleHash = "a".repeat(64);
const handshake: WorkerAdmissionHandshake = {
  bundleHash,
  openclawVersion: "2026.7.11",
  protocolFeatures: [],
};
const credential = ["worker", "credential", "fixture"].join("-");
const connectParams = {
  minProtocol: 1,
  maxProtocol: 1,
  client: {
    id: GATEWAY_CLIENT_IDS.WORKER,
    version: "2026.7.11",
    platform: "linux",
    mode: GATEWAY_CLIENT_MODES.WORKER,
  },
  role: "worker",
  admission: {
    environmentId: "worker-1",
    credential,
    sessionId: null,
    runId: null,
    ownerEpoch: 1,
    rpcSetVersion: WORKER_RPC_SET_VERSION,
    handshake,
  },
};
const request = <const Method extends string, T>(method: Method, params: T) => ({
  type: "req" as const,
  id: "request-1",
  method,
  params,
});
const response = (payload: unknown) => ({ type: "res", id: "response-1", ok: true, payload });
const workerHello = {
  type: "worker-hello-ok" as const,
  environmentId: "worker-1",
  sessionId: null,
  ownerEpoch: 1,
  rpcSetVersion: WORKER_RPC_SET_VERSION,
  protocolFeatures: ["worker-heartbeat-v1"],
  credentialExpiresAtMs: 10_000,
  policy: { heartbeatIntervalMs: 15_000, maxPayload: 1_024 },
};
const usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistantMessage = {
  role: "assistant" as const,
  content: [{ type: "toolCall" as const, id: "call-1", name: "probe", arguments: { value: 1 } }],
  api: "responses",
  provider: "fixture",
  model: "fixture-model",
  usage,
  stopReason: "toolUse" as const,
  timestamp: 2,
};
const transcriptMessages = [
  { role: "user" as const, content: [{ type: "text" as const, text: "probe" }], timestamp: 1 },
  assistantMessage,
  {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName: "probe",
    content: [{ type: "text" as const, text: "ok" }],
    isError: false,
    timestamp: 3,
  },
];
const transcriptCommit = (overrides: Record<string, unknown> = {}) => ({
  runEpoch: 2,
  seq: 1,
  baseLeafId: null,
  messages: transcriptMessages,
  ...overrides,
});
const transcriptMessage = (message: unknown) => transcriptCommit({ messages: [message] });
const commitResponse = (value: Record<string, unknown>) =>
  Value.Check(CommitResponse, { type: "res", id: "commit-1", ...value });
const commitError = (message: string, reason: string) =>
  commitResponse({ ok: false, error: { code: "INVALID_REQUEST", message, details: { reason } } });
const liveBase = { runEpoch: 2, lastAckedSeq: 0, seq: 1, runId: "r" };
const models = { selectedProvider: "p", selectedModel: "m", activeProvider: "q", activeModel: "n" };
const event = (kind: string, payload: Record<string, unknown>) => ({ kind, payload });
const params = (liveEvent: unknown, overrides: Record<string, unknown> = {}) => ({
  ...liveBase,
  event: liveEvent,
  ...overrides,
});
const tool = (phase: string, payload: Record<string, unknown>) =>
  event("tool", { phase, name: "t", toolCallId: "c", ...payload });

const inferenceIdentity = { runEpoch: 2, sessionId: "s", runId: "r", turnId: "t" };
const inferenceFrame = (kind: string, payload: object) => ({
  type: "event",
  event: `worker.inference.${kind}`,
  payload: { ...inferenceIdentity, seq: 1, ...payload },
});
const inferenceStart = {
  ...inferenceIdentity,
  modelRef: { provider: "fixture-provider", model: "fixture-model" },
  context: { messages: [{ role: "user" as const, content: "probe", timestamp: 1 }] },
  options: { temperature: 0.5, maxTokens: 1_024, reasoning: "medium" as const },
};
const inferenceMessages = (messages: unknown[]) => ({ ...inferenceStart, context: { messages } });
function check<T>(validate: (value: T) => boolean, value: T, valid = true) {
  expect(validate(value)).toBe(valid);
}
function checkAll<T>(validate: (value: T) => unknown, values: readonly T[], want: unknown = true) {
  for (const value of values) {
    expect(validate(value)).toEqual(want);
  }
}
function checkSchema(schema: TSchema, value: unknown) {
  expect(Value.Check(schema, value)).toBe(true);
}
const approval = (phase: string, status: string) =>
  event("approval", { phase, kind: "exec", status, title: "x" });
const lifecycle = (phase: string, payload: Record<string, unknown> = {}) =>
  event("lifecycle", { phase, ...payload });
const fallbackStep = (outcome: string, reason?: string) =>
  lifecycle("fallback_step", {
    fallbackStepType: "fallback_step",
    fallbackStepFromModel: "p/m",
    ...(reason === undefined ? {} : { fallbackStepFromFailureReason: reason }),
    fallbackStepFinalOutcome: outcome,
  });
const fallbackReasonEvents = (reason: string) => [
  lifecycle("fallback", {
    ...models,
    reasonSummary: "x",
    attemptSummaries: ["x"],
    attempts: [{ provider: "p", model: "m", error: "x", reason }],
  }),
  fallbackStep("next_fallback", reason),
];
const assistant = event("assistant", { text: "x", delta: "x" });
const liveError = (details: Record<string, unknown>) => ({
  ok: false,
  error: { code: "INVALID_REQUEST", message: "x", details },
});
const liveRequest = (value: unknown) =>
  Value.Check(LiveRequest, request("worker.live-event", value));
const liveResponse = (value: Record<string, unknown>) =>
  Value.Check(LiveResponse, { type: "res", id: "l", ...value });

describe("worker protocol schemas", () => {
  it("accepts the bootstrap receipt and future unique feature names", () => {
    checkAll(validateHandshake, [
      handshake,
      { ...handshake, protocolFeatures: ["run-v1", "resume-v1"] },
    ]);
  });

  it("rejects malformed admission identity", () => {
    check(validateHandshake, { ...handshake, bundleHash: "short" }, false);
  });
  it("accepts a dedicated connect and explicit unattached session", () => {
    check(validateConnect, request("connect", connectParams));
    const missingRunId = structuredClone(connectParams);
    Reflect.deleteProperty(missingRunId.admission, "runId");
    check(validateConnect, request("connect", missingRunId), false);
    for (const admission of [
      { ...connectParams.admission, sessionId: null, runId: "run-1" },
      { ...connectParams.admission, sessionId: "session-1", runId: null },
    ]) {
      check(validateConnect, request("connect", { ...connectParams, admission }), false);
    }
    checkSchema(AdmissionResponse, response(workerHello));
  });

  it("validates heartbeat status frames", () => {
    check(validateHeartbeat, { sentAtMs: 1, status: "ready" });
    check(validateHeartbeat, { sentAtMs: 1, status: "unknown" }, false);
    checkSchema(HeartbeatRequest, request("worker.heartbeat", { sentAtMs: 1, status: "busy" }));
    checkSchema(HeartbeatResponse, response({ receivedAtMs: 2, status: "ok", ownerEpoch: 1 }));
  });

  it("accepts semantic transcript commits and generated-id responses", () => {
    const commitParams = transcriptCommit();
    check(validateCommit, commitParams);
    checkSchema(CommitRequest, request("worker.transcript.commit", commitParams));
    const committed = { entryIds: ["entry-1", "entry-2", "entry-3"], newLeafId: "entry-3" };
    check(commitResponse, { ok: true, payload: committed });
    expect(commitError("worker request rejected", "credential-replaced")).toBe(true);
    expect(commitError("transcript commit rejected", "stale-base-leaf")).toBe(true);
  });

  it("accepts bounded opaque provider response IDs across worker message transports", () => {
    const accepts = (responseId: string) => {
      const message = { ...assistantMessage, responseId };
      return [
        validateCommit(transcriptMessage(message)),
        validateInferenceStart(inferenceMessages([message])),
        validateInferenceTerminal(
          inferenceFrame("terminal", { outcome: { type: "done", message } }),
        ),
      ];
    };

    // Compatible providers can encode routing state in IDs longer than internal worker IDs.
    checkAll(
      accepts,
      ["response" + "x".repeat(477), "x".repeat(MAX_PAYLOAD_BYTES)],
      [true, true, true],
    );
    checkAll(
      accepts,
      ["", " ", " response", "response ", "x".repeat(MAX_PAYLOAD_BYTES + 1)],
      [false, false, false],
    );
    check(
      validateCommit,
      transcriptMessage({ ...assistantMessage, model: "x".repeat(257) }),
      false,
    );
    check(validateInferenceStart, { ...inferenceStart, runId: "x".repeat(257) }, false);
    for (const [responseId, withinBudget] of [
      ["response" + "x".repeat(477), true],
      ["x".repeat(MAX_PAYLOAD_BYTES), false],
    ] as const) {
      expect(
        isWorkerTranscriptFrameWithinBudget(
          request(
            "worker.transcript.commit",
            transcriptMessage({ ...assistantMessage, responseId }),
          ),
        ),
      ).toBe(withinBudget);
    }
  });

  it("accepts opaque provider replay state on assistant transcript messages", () => {
    const providerReplay = {
      v: 1 as const,
      type: "openai-responses-compaction",
      id: "cmp_worker",
      data: "opaque-worker-compaction",
      replayIndex: 1,
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.6-luna",
      baseUrlHash: "ozhevd1smnk8s",
      sessionHash: "171dzdv17gum5g",
      authProfileHash: "oe8bkr3r8947",
    };
    const validateReplay = (overrides: Record<string, unknown> = {}) =>
      validateCommit(
        transcriptMessage({
          ...assistantMessage,
          providerReplay: { ...providerReplay, ...overrides },
        }),
      );
    checkAll(validateReplay, [{}, { data: "x".repeat(MAX_REPLAY_BYTES) }]);
    checkAll(
      validateReplay,
      [{ privateScratch: "drop" }, { data: "x".repeat(MAX_REPLAY_BYTES + 1) }],
      false,
    );
  });

  it("advertises only the current execution-context dialect", () => {
    expect(WORKER_PROTOCOL_FEATURES).not.toContain(WORKER_LAUNCH_V2_PROTOCOL_FEATURE);
    expect(WORKER_PROTOCOL_FEATURES).not.toContain("worker-execution-context-v1");
    expect(WORKER_PROTOCOL_FEATURES).toContain("worker-execution-context-v2");
  });

  it("validates the additive live-event protocol", () => {
    expect(WORKER_RPC_SET_VERSION).toBe(1);
    expect(WORKER_PROTOCOL_FEATURES).toContain("worker-live-event-v1");
    for (const validEvent of [
      assistant,
      event("thinking", { text: "x", delta: "x" }),
      tool("start", { args: {} }),
      tool("update", { partialResult: { output: "x" } }),
      tool("result", { result: { output: "x" }, isError: false }),
      approval("requested", "pending"),
      approval("resolved", "approved"),
      lifecycle("start", { startedAt: 1 }),
      lifecycle("fallback", {
        ...models,
        reasonSummary: "x",
        attemptSummaries: ["x"],
        attempts: [{ provider: "p", model: "m", error: "x", authMode: "key" }],
      }),
      lifecycle("fallback_cleared", models),
      fallbackStep("next_fallback"),
      lifecycle("finishing", { endedAt: 2, error: "x" }),
      lifecycle("end", { endedAt: 3 }),
      lifecycle("error", { endedAt: 4, error: "x" }),
    ]) {
      check(validateLive, params(validEvent));
    }
    check(liveRequest, params(assistant));
    check(liveResponse, { ok: true, payload: { ackedSeq: 3 } });
    for (const details of [
      { reason: "epoch-mismatch" },
      { reason: "session-not-attached" },
      { reason: "invalid-event" },
      { reason: "capacity-exceeded" },
      { reason: "resync-required", ackedSeq: 3, expectedSeq: 4 },
    ]) {
      check(liveResponse, liveError(details));
    }
    checkAll(
      liveResponse,
      [liveError({ reason: "later" }), { ok: true, payload: { ackedSeq: -1 } }],
      false,
    );
    for (const [field, value] of [
      ["runEpoch", -1],
      ["lastAckedSeq", -1],
      ["lastAckedSeq", Number.MAX_SAFE_INTEGER + 1],
      ["seq", 0],
      ["seq", Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      check(validateLive, params(assistant, { [field]: value }), false);
    }
    for (const invalid of [
      params(event("unknown", {})),
      params(tool("start", { args: {}, partialResult: {} })),
      params(approval("requested", "approved")),
      params(lifecycle("end", { endedAt: 4, error: "stopped" })),
      params(fallbackStep("retrying")),
      params({ ...assistant, seq: 8 }),
      params(assistant, { sessionKey: "x" }),
      {
        runEpoch: liveBase.runEpoch,
        seq: liveBase.seq,
        runId: liveBase.runId,
        event: assistant,
      },
    ]) {
      check(validateLive, invalid, false);
    }
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const [value, keyword] of [
      [Number.POSITIVE_INFINITY, "finite"],
      [cyclic, "acyclic"],
    ] as const) {
      expect(validateLive(params(tool("update", { partialResult: value })))).toBe(false);
      expect(validateLive.errors?.[0]).toMatchObject({ keyword });
    }
  });

  it("keeps both worker fallback reason fields aligned with the canonical vocabulary", () => {
    const validate = (liveEvent: unknown) => validateLive(params(liveEvent));
    checkAll(validate, FAILOVER_REASONS.flatMap(fallbackReasonEvents));
    checkAll(validate, fallbackReasonEvents("not-a-reason"), false);
  });

  it("accepts only a model reference and constrained inference options", () => {
    check(validateInferenceStart, {
      ...inferenceStart,
      options: { ...inferenceStart.options, reasoning: "adaptive" },
    });
    const route = { baseUrl: "https://invalid.example", headers: { "x-route": "override" } };
    for (const candidate of [
      { ...inferenceStart, model: { provider: "p", id: "m", ...route } },
      { ...inferenceStart, modelRef: { ...inferenceStart.modelRef, ...route } },
      { ...inferenceStart, options: { ...inferenceStart.options, ...route } },
      { ...inferenceStart, options: { ...inferenceStart.options, arbitrary: true } },
      { ...inferenceStart, options: { maxTokens: WORKER_INFERENCE_MAX_OUTPUT_TOKENS + 1 } },
    ]) {
      check(validateInferenceStart, candidate, false);
    }
  });

  it("keeps inference content events closed and indexed", () => {
    const contentEvent = { type: "toolcall_start", id: "call-1", toolName: "probe" };
    const validateEvent = (value: unknown) =>
      validateInferenceEvent(inferenceFrame("event", { event: value }));
    check(validateEvent, { ...contentEvent, contentIndex: 0 });
    checkAll(
      validateEvent,
      [
        contentEvent,
        { ...contentEvent, contentIndex: -1 },
        { ...contentEvent, contentIndex: 0, unexpected: true },
      ],
      false,
    );
  });

  it.each([
    transcriptCommit({ sessionId: "other" }),
    transcriptCommit({ messages: [{ ...transcriptMessages[0], id: "entry-from-worker" }] }),
    transcriptCommit({ messages: [{ ...transcriptMessages[0], parentId: "parent-from-worker" }] }),
    transcriptCommit({ messages: [{ ...transcriptMessages[0], sessionId: "foreign-session" }] }),
  ])("rejects raw transcript identity or invalid batch fields %#", (candidate) => {
    check(validateCommit, candidate, false);
  });

  it("rejects deeply nested worker JSON before schema compilation", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth <= WORKER_TRANSCRIPT_MAX_JSON_DEPTH; depth += 1) {
      nested = { nested };
    }
    const candidate = transcriptMessage({
      ...assistantMessage,
      content: [{ ...assistantMessage.content[0], arguments: { nested } }],
    });

    expect(validateCommit(candidate)).toBe(false);
    expect(validateCommit.errors?.[0]).toMatchObject({
      keyword: "maxDepth",
      params: { limit: WORKER_TRANSCRIPT_MAX_JSON_DEPTH },
    });
  });

  it("keeps worker close reasons closed", () => {
    const validate = (value: string) => Value.Check(CloseReason, value);
    checkAll(validate, ["admission-rejected", "credential-replaced", "placement-mismatch"]);
    check(validate, "not-a-worker-reason", false);
  });
});

describe("worker message wire boundaries", () => {
  it.each([
    [[true, true, true], { type: "image", data: "encoded", mimeType: "image/png" }],
    [[false, true, false], { type: "text", text: "a".repeat(MAX_PAYLOAD_BYTES + 1) }],
  ] as const)("retains each transport's content limits (%j)", (accepts, content) => {
    const message = { role: "user", content: [content], timestamp: 1 };
    expect([
      validateCommit(transcriptMessage(message)),
      validateInferenceStart(inferenceMessages([message])),
      Value.Check(GatewayToolResult, { content: [content] }),
    ]).toEqual(accepts);
  });

  it("admits text-only runtime context and rejects image payloads", () => {
    const validateContent = (content: unknown) =>
      validateInferenceStart(
        inferenceMessages([
          { ...transcriptMessages[0], content, runtimeContext: { retained: true } },
        ]),
      );
    check(validateContent, [{ type: "text", text: "current facts" }]);
    check(validateContent, [{ type: "image", data: "encoded", mimeType: "image/png" }], false);
  });
});
