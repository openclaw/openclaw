import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedPiQueueMessageOutcome } from "./pi-embedded-runner/runs.js";
import { createSubagentAnnounceDeliveryRuntimeMock } from "./subagent-announce.test-support.js";

type AgentCallRequest = { method?: string; params?: Record<string, unknown> };

const agentSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "run-main", status: "ok" }));
const sessionsDeleteSpy = vi.fn((_req: AgentCallRequest) => undefined);
const callGatewayMock = vi.fn(async (_request: unknown) => ({}));
const loadSessionStoreMock = vi.fn((_storePath: string) => ({}));
const resolveAgentIdFromSessionKeyMock = vi.fn((sessionKey: string) => {
  return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
});
const resolveStorePathMock = vi.fn((_store: unknown, _options: unknown) => "/tmp/sessions.json");
const resolveMainSessionKeyMock = vi.fn((_cfg: unknown) => "agent:main:main");
const readLatestAssistantReplyMock = vi.fn(async (_params?: unknown) => "raw subagent reply");
const isEmbeddedPiRunActiveMock = vi.fn((_sessionId: string) => false);
const queueEmbeddedPiMessageWithOutcomeMock = vi.fn(
  (sessionId: string, _text: string, _options?: unknown): EmbeddedPiQueueMessageOutcome => ({
    queued: false,
    sessionId,
    reason: "not_streaming" as const,
    gatewayHealth: "live" as const,
  }),
);
const waitForEmbeddedPiRunEndMock = vi.fn(async (_sessionId: string, _timeoutMs?: number) => true);
let mockConfig: ReturnType<(typeof import("../config/config.js"))["getRuntimeConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

const { subagentRegistryRuntimeMock } = vi.hoisted(() => ({
  subagentRegistryRuntimeMock: {
    shouldIgnorePostCompletionAnnounceForSession: vi.fn(() => false),
    isSubagentSessionRunActive: vi.fn(() => true),
    countActiveDescendantRuns: vi.fn(() => 0),
    countPendingDescendantRuns: vi.fn(() => 0),
    countPendingDescendantRunsExcludingRun: vi.fn(() => 0),
    listSubagentRunsForRequester: vi.fn(() => []),
    getLatestSubagentRunByChildSessionKey: vi.fn(() => null),
    beginSubagentCompletionDedupe: vi.fn(() => ({
      duplicate: false,
      counters: { seenCount: 1, duplicateCount: 0 },
    })),
    markSubagentCompletionDedupeDelivered: vi.fn(() => ({
      duplicate: false,
      counters: { seenCount: 1, duplicateCount: 0 },
    })),
    replaceSubagentRunAfterSteer: vi.fn(() => true),
    resolveRequesterForChildSession: vi.fn(() => null),
  },
}));

vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: (request: unknown) => callGatewayMock(request),
  dispatchGatewayMethodInProcess: (
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => callGatewayMock({ method, params, timeoutMs: options?.timeoutMs }),
  isEmbeddedPiRunActive: (sessionId: string) => isEmbeddedPiRunActiveMock(sessionId),
  getRuntimeConfig: () => mockConfig,
  loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
  resolveAgentIdFromSessionKey: (sessionKey: string) =>
    resolveAgentIdFromSessionKeyMock(sessionKey),
  resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
  resolveStorePath: (store: unknown, options: unknown) => resolveStorePathMock(store, options),
  waitForEmbeddedPiRunEnd: (sessionId: string, timeoutMs?: number) =>
    waitForEmbeddedPiRunEndMock(sessionId, timeoutMs),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: (params?: unknown) => readLatestAssistantReplyMock(params),
}));

vi.mock("./subagent-announce-delivery.runtime.js", () =>
  createSubagentAnnounceDeliveryRuntimeMock({
    callGateway: (request: unknown) => callGatewayMock(request),
    getRuntimeConfig: () => mockConfig,
    loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
    resolveAgentIdFromSessionKey: (sessionKey: string) =>
      resolveAgentIdFromSessionKeyMock(sessionKey),
    resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
    resolveStorePath: (store: unknown, options: unknown) => resolveStorePathMock(store, options),
    isEmbeddedPiRunActive: (sessionId: string) => isEmbeddedPiRunActiveMock(sessionId),
    queueEmbeddedPiMessageWithOutcome: (sessionId: string, text: string, options?: unknown) =>
      queueEmbeddedPiMessageWithOutcomeMock(sessionId, text, options),
  }),
);

vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: async (params: {
    targetRequesterSessionKey: string;
    triggerMessage: string;
    requesterIsSubagent?: boolean;
    requesterOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string };
    completionDirectOrigin?: {
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string;
    };
    directOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string };
    requesterSessionOrigin?: { provider?: string; channel?: string };
    bestEffortDeliver?: boolean;
    internalEvents?: unknown[];
    userDeliveryEligible?: boolean;
    sourceSessionKey?: string;
    sourceChannel?: string;
    sourceTool?: string;
  }) => {
    const store = loadSessionStoreMock("/tmp/sessions.json") as Record<string, unknown>;
    const requesterEntry = (store?.[params.targetRequesterSessionKey] ?? {}) as
      | { sessionId?: string; origin?: { provider?: string; channel?: string } }
      | undefined;
    const sessionId = requesterEntry?.sessionId?.trim();
    const queueChannel =
      requesterEntry?.origin?.provider ??
      requesterEntry?.origin?.channel ??
      params.requesterSessionOrigin?.provider ??
      params.requesterSessionOrigin?.channel;

    if (
      params.userDeliveryEligible !== false &&
      sessionId &&
      queueChannel === "discord" &&
      isEmbeddedPiRunActiveMock(sessionId)
    ) {
      queueEmbeddedPiMessageWithOutcomeMock(
        sessionId,
        `[Internal task completion event]\n${params.triggerMessage}`,
        { steeringMode: "all" },
      );
      return { delivered: true, path: "steered" };
    }

    const effectiveOrigin =
      params.completionDirectOrigin ?? params.requesterOrigin ?? params.directOrigin;

    await callGatewayMock({
      method: "agent",
      params: {
        sessionKey: params.targetRequesterSessionKey,
        message: params.triggerMessage,
        deliver:
          params.userDeliveryEligible !== false &&
          !params.requesterIsSubagent &&
          effectiveOrigin?.channel !== "webchat" &&
          Boolean(effectiveOrigin?.channel && effectiveOrigin?.to),
        bestEffortDeliver: params.bestEffortDeliver,
        internalEvents: params.internalEvents,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: params.sourceSessionKey,
          sourceChannel: params.sourceChannel,
          sourceTool: params.sourceTool ?? "subagent_announce",
        },
        ...(params.requesterIsSubagent
          ? {}
          : {
              channel: effectiveOrigin?.channel,
              to: effectiveOrigin?.to,
              accountId: effectiveOrigin?.accountId,
              threadId: effectiveOrigin?.threadId,
            }),
      },
    });

    return { delivered: true, path: "direct" };
  },
  loadRequesterSessionEntry: (sessionKey: string) => {
    const store = loadSessionStoreMock("/tmp/sessions.json") as Record<string, unknown>;
    const entry = store?.[sessionKey];
    return { entry };
  },
  loadSessionEntryByKey: (sessionKey: string) => {
    const store = loadSessionStoreMock("/tmp/sessions.json") as Record<string, unknown>;
    return store?.[sessionKey] ?? { sessionId: sessionKey };
  },
  resolveAnnounceOrigin: (
    entry:
      | {
          lastChannel?: string;
          lastTo?: string;
          lastAccountId?: string;
          lastThreadId?: string;
          origin?: { provider?: string; channel?: string; accountId?: string };
        }
      | undefined,
    requesterOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string },
  ) => ({
    channel:
      requesterOrigin?.channel ??
      entry?.lastChannel ??
      entry?.origin?.provider ??
      entry?.origin?.channel,
    to: requesterOrigin?.to ?? entry?.lastTo,
    accountId: requesterOrigin?.accountId ?? entry?.lastAccountId ?? entry?.origin?.accountId,
    threadId: requesterOrigin?.threadId ?? entry?.lastThreadId,
  }),
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
}));

vi.mock("./subagent-announce.registry.runtime.js", () => subagentRegistryRuntimeMock);
import { applySubagentWaitOutcome } from "./subagent-announce-output.js";
import {
  __testing as subagentAnnounceTesting,
  buildChildCompletionDeliveryDecision,
  runSubagentAnnounceFlow,
} from "./subagent-announce.js";
import { CHILD_RESULT_DUPLICATE_COMPLETION } from "./subagent-child-result-contract.js";

function requireQueuedMessageCall() {
  const call = queueEmbeddedPiMessageWithOutcomeMock.mock.calls[0];
  if (!call) {
    throw new Error("expected queued message call");
  }
  return call;
}

function requireAgentCall() {
  const call = agentSpy.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("expected agent call");
  }
  return call;
}

describe("subagent wait outcome timing", () => {
  it.each([
    { wait: { status: "ok" }, expected: { status: "ok" } },
    { wait: { status: "timeout" }, expected: { status: "timeout" } },
    {
      wait: { status: "error", error: "boom" },
      expected: { status: "error", error: "boom" },
    },
  ] as const)("adds timing to $wait.status outcomes", ({ wait, expected }) => {
    const result = applySubagentWaitOutcome({
      wait,
      outcome: undefined,
      startedAt: 1_000,
      endedAt: 1_250,
    });

    expect(result.outcome).toEqual({
      ...expected,
      startedAt: 1_000,
      endedAt: 1_250,
      elapsedMs: 250,
    });
  });
});

describe("subagent announce seam flow", () => {
  beforeEach(() => {
    subagentAnnounceTesting.resetCompletionDedupeForTest();
    agentSpy.mockClear();
    sessionsDeleteSpy.mockClear();
    callGatewayMock.mockReset().mockImplementation(async (req: unknown) => {
      const typed = req as AgentCallRequest;
      if (typed.method === "agent") {
        return await agentSpy(typed);
      }
      if (typed.method === "agent.wait") {
        return { status: "ok", startedAt: 10, endedAt: 20 };
      }
      if (typed.method === "chat.history") {
        return { messages: [] as Array<unknown> };
      }
      if (typed.method === "sessions.patch") {
        return {};
      }
      if (typed.method === "sessions.delete") {
        sessionsDeleteSpy(typed);
        return {};
      }
      return {};
    });
    loadSessionStoreMock.mockReset().mockImplementation(() => ({}));
    resolveAgentIdFromSessionKeyMock.mockReset().mockImplementation(() => "main");
    resolveStorePathMock.mockReset().mockImplementation(() => "/tmp/sessions.json");
    resolveMainSessionKeyMock.mockReset().mockImplementation(() => "agent:main:main");
    readLatestAssistantReplyMock.mockReset().mockResolvedValue("raw subagent reply");
    isEmbeddedPiRunActiveMock.mockReset().mockReturnValue(false);
    queueEmbeddedPiMessageWithOutcomeMock.mockReset().mockImplementation((sessionId: string) => ({
      queued: false,
      sessionId,
      reason: "not_streaming",
      gatewayHealth: "live",
    }));
    waitForEmbeddedPiRunEndMock.mockReset().mockResolvedValue(true);
    mockConfig = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
    subagentRegistryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockReset();
    subagentRegistryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockReturnValue(false);
    subagentRegistryRuntimeMock.isSubagentSessionRunActive.mockReset();
    subagentRegistryRuntimeMock.isSubagentSessionRunActive.mockReturnValue(true);
    subagentRegistryRuntimeMock.countActiveDescendantRuns.mockReset();
    subagentRegistryRuntimeMock.countActiveDescendantRuns.mockReturnValue(0);
    subagentRegistryRuntimeMock.countPendingDescendantRuns.mockReset();
    subagentRegistryRuntimeMock.countPendingDescendantRuns.mockReturnValue(0);
    subagentRegistryRuntimeMock.countPendingDescendantRunsExcludingRun.mockReset();
    subagentRegistryRuntimeMock.countPendingDescendantRunsExcludingRun.mockReturnValue(0);
    subagentRegistryRuntimeMock.listSubagentRunsForRequester.mockReset();
    subagentRegistryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([]);
    subagentRegistryRuntimeMock.getLatestSubagentRunByChildSessionKey.mockReset();
    subagentRegistryRuntimeMock.getLatestSubagentRunByChildSessionKey.mockReturnValue(null);
    subagentRegistryRuntimeMock.beginSubagentCompletionDedupe.mockReset();
    subagentRegistryRuntimeMock.beginSubagentCompletionDedupe.mockReturnValue({
      duplicate: false,
      counters: { seenCount: 1, duplicateCount: 0 },
    });
    subagentRegistryRuntimeMock.markSubagentCompletionDedupeDelivered.mockReset();
    subagentRegistryRuntimeMock.markSubagentCompletionDedupeDelivered.mockReturnValue({
      duplicate: false,
      counters: { seenCount: 1, duplicateCount: 0 },
    });
    subagentRegistryRuntimeMock.replaceSubagentRunAfterSteer.mockReset();
    subagentRegistryRuntimeMock.replaceSubagentRunAfterSteer.mockReturnValue(true);
    subagentRegistryRuntimeMock.resolveRequesterForChildSession.mockReset();
    subagentRegistryRuntimeMock.resolveRequesterForChildSession.mockReturnValue(null);
  });

  it("adds a non-accept status card for unschemaed active-task child output", async () => {
    const rawChildBody = "raw child body that must not be shown as completion";

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:malformed",
      childRunId: "run-malformed-status-card",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "telegram", to: "-100123", accountId: "default" },
      task: "malformed status card",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: rawChildBody,
      expectsCompletionMessage: true,
      activeTaskContract: {
        taskId: "malformed-status-card",
        currentUserRequest: "Require schema-backed active task evidence.",
        inputArtifacts: [],
        expectedOutputArtifacts: [],
        allowedSideEffects: [],
        authorizationSource: { kind: "test", reference: "current" },
        nonGoals: [],
      },
    });

    expect(didAnnounce).toBe(true);
    const agentCall = requireAgentCall();
    const message = String(agentCall.params?.message ?? "");
    const event = (
      agentCall.params?.internalEvents as
        | Array<{
            result?: string;
            statusCard?: Record<string, unknown> & { quarantine?: Record<string, unknown> };
          }>
        | undefined
    )?.[0];
    const statusCard = event?.statusCard;

    expect(agentCall.params?.deliver).toBe(false);
    expect(statusCard).toMatchObject({
      deliveryState: "quarantined",
      action: "validate_artifact_or_retry",
      transportOutcome: "completed",
      contractVerdict: "MISSING_VERDICT_SCHEMA",
      acceptanceEligible: false,
      rawBodySuppressed: true,
      userVisibleSuppressed: true,
      userVisibleSuppressedReason: "RAW_BODY_QUARANTINED",
      presentation: {
        mode: "status_card",
        ordinaryChatBubble: "suppressed",
        collapsedByDefault: true,
        severity: "warning",
      },
      rawOpen: {
        requiredAction: "open_raw_quarantine_artifact",
        localOperatorActionRequired: true,
        authorization: { required: true, status: "not_requested" },
        audit: { mode: "metadata_only" },
        viewer: {
          isolation: "outside_ordinary_chat_model_context_compaction",
          defaultPreview: false,
          snippets: false,
          renderedPayload: false,
          rawDerivedFilename: false,
        },
        redactionScan: { scanned: true, rawSnippetStored: false },
      },
    });
    expect(statusCard).not.toHaveProperty("delivery");
    expect(statusCard).not.toHaveProperty("suppression");
    expect(event).not.toHaveProperty("suppression");
    expect(statusCard?.quarantine).toMatchObject({
      source: "assistant_output",
    });
    expect(statusCard?.labels).toEqual(
      expect.arrayContaining(["MALFORMED_QUARANTINED", "NOT_ACCEPTANCE_EVIDENCE"]),
    );
    expect(statusCard?.debugRefs).toMatchObject({
      artifactId: expect.stringMatching(/^q_/),
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(event?.result).not.toContain(rawChildBody);
    expect(message).not.toContain(rawChildBody);
    expect(message).not.toContain("NO_REPLY");
    expect(message).not.toContain("ready for user delivery");
    expect(message).not.toContain("ready for parent review");
    expect(JSON.stringify(statusCard)).not.toContain("bodyPreview");
    expect(JSON.stringify(statusCard)).not.toContain("payloadPath");
    expect(JSON.stringify(statusCard)).not.toContain("metadataPath");
    expect(JSON.stringify(statusCard)).not.toContain(rawChildBody);
  });

  it("requires direct verification after a second identical malformed retry in announce runtime", async () => {
    const attempt = {
      mechanismKey: "default",
      profileKey: "default",
      promptHash: "c".repeat(64),
    };
    subagentRegistryRuntimeMock.listSubagentRunsForRequester.mockImplementation((key: string) =>
      key === "agent:main:main"
        ? [
            {
              runId: "run-prior-malformed",
              childSessionKey: "agent:main:subagent:prior-malformed",
              requesterSessionKey: "agent:main:main",
              requesterDisplayKey: "main",
              task: "identical malformed retry",
              cleanup: "keep",
              createdAt: 1,
              childResultRetryAttempt: {
                ...attempt,
                contractVerdict: "MISSING_VERDICT_SCHEMA",
              },
            },
          ]
        : [],
    );
    subagentRegistryRuntimeMock.getLatestSubagentRunByChildSessionKey.mockReturnValue({
      runId: "run-current-malformed",
      childSessionKey: "agent:main:subagent:current-malformed",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "identical malformed retry",
      cleanup: "keep",
      createdAt: 2,
      childResultRetryAttempt: attempt,
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:current-malformed",
      childRunId: "run-current-malformed",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "telegram", to: "-100123", accountId: "default" },
      task: "identical malformed retry",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "raw child body without verdict schema",
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    const agentCall = requireAgentCall();
    const event = (
      agentCall.params?.internalEvents as
        | Array<{
            statusCard?: Record<string, unknown> & { retryPolicy?: Record<string, unknown> };
          }>
        | undefined
    )?.[0];
    const statusCard = event?.statusCard;

    expect(statusCard).toMatchObject({
      deliveryState: "validation_required",
      action: "report_blocker_or_rework",
      contractVerdict: "MISSING_VERDICT_SCHEMA",
      userVisibleSuppressedReason: "DIRECT_VERIFICATION_REQUIRED",
      retryPolicy: {
        retryAllowed: false,
        directVerificationRequired: true,
        sameAttemptFingerprintMalformedRetries: 2,
      },
    });
    expect(statusCard?.reasons).toContain("DIRECT_VERIFICATION_REQUIRED");
    const persisted = subagentRegistryRuntimeMock.markSubagentCompletionDedupeDelivered.mock
      .calls[0]?.[0] as {
      retryAttempt?: Record<string, unknown>;
      retryPolicy?: Record<string, unknown>;
    };
    expect(persisted.retryAttempt).toMatchObject({
      contractVerdict: "MISSING_VERDICT_SCHEMA",
      mechanismKey: "default",
      profileKey: "default",
    });
    expect(persisted.retryPolicy).toMatchObject({
      retryAllowed: false,
      directVerificationRequired: true,
    });
  });

  it.each([
    {
      name: "TypeScript source",
      raw: [
        "import { secret } from './secrets.js';",
        "export function leak() {",
        "const sentinel = 'DO_NOT_INJECT_PARENT_SOURCE';",
        "if (secret) {",
        "return sentinel;",
        "}",
        "for (const item of [1, 2, 3]) {",
        "return String(item);",
        "}",
      ].join("\n"),
      absent: "DO_NOT_INJECT_PARENT_SOURCE",
      verdict: "MALFORMED_RAW_SOURCE_OUTPUT",
      label: "RAW_SOURCE_LIKE",
    },
    {
      name: "raw diff",
      raw: [
        "diff --git a/src/secret.ts b/src/secret.ts",
        "index 1111111..2222222 100644",
        "@@ -1,3 +1,5 @@",
        "-export const value = 'old';",
        "+export const value = 'DO_NOT_INJECT_PARENT_DIFF';",
        "+export const other = 'new';",
        "-console.log(value);",
        "+console.log(value, other);",
      ].join("\n"),
      absent: "DO_NOT_INJECT_PARENT_DIFF",
      verdict: "MALFORMED_RAW_SOURCE_OUTPUT",
      label: "RAW_DIFF_LIKE",
    },
    {
      name: "long test log",
      raw: [
        "$ pnpm vitest run src/agents/subagent-announce.test.ts",
        "Process exited with code 1",
        "FAIL src/agents/subagent-announce.test.ts",
        "DO_NOT_INJECT_PARENT_LOG".repeat(400),
      ].join("\n"),
      absent: "DO_NOT_INJECT_PARENT_LOG",
      verdict: "MALFORMED_TOOL_LOG_OUTPUT",
      label: "RAW_LOG_LIKE",
    },
  ])("announces $name as malformed metadata only", async ({ raw, absent, verdict, label }) => {
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:wave2-malformed",
      childRunId: `run-wave2-${label.toLowerCase()}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "telegram", to: "-100123", accountId: "default" },
      task: `wave2 ${label}`,
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      outcome: { status: "ok" },
      roundOneReply: raw,
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    const agentCall = requireAgentCall();
    const message = String(agentCall.params?.message ?? "");
    const event = (
      agentCall.params?.internalEvents as
        | Array<{
            result?: string;
            statusCard?: Record<string, unknown> & {
              quarantine?: Record<string, unknown>;
              provenance?: Record<string, unknown>;
            };
          }>
        | undefined
    )?.[0];
    const statusCard = event?.statusCard;
    const labels = statusCard?.classificationLabels as string[] | undefined;

    expect(agentCall.params?.deliver).toBe(false);
    expect(agentCall.params?.inputProvenance).toMatchObject({
      kind: "inter_session",
      sourceSessionKey: "agent:main:subagent:wave2-malformed",
      sourceTool: "subagent_announce",
    });
    expect(statusCard).toMatchObject({
      normalizedState: "MALFORMED",
      schemaValid: false,
      notAcceptanceEvidence: true,
      deliveryState: "quarantined",
      action: "validate_artifact_or_retry",
      contractVerdict: verdict,
      acceptanceEligible: false,
      rawBodySuppressed: true,
      userVisibleSuppressed: true,
      provenance: {
        childRunId: `run-wave2-${label.toLowerCase()}`,
        childSessionKey: "agent:main:subagent:wave2-malformed",
        requesterSessionKey: "agent:main:main",
      },
    });
    expect(labels).toContain(label);
    expect(String(statusCard?.quarantine?.artifactId ?? statusCard?.quarantine?.path)).toMatch(
      /^q_/,
    );
    expect(String(statusCard?.quarantine?.payloadHash ?? statusCard?.quarantine?.sha256)).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(
      Number(statusCard?.quarantine?.byteCount ?? statusCard?.quarantine?.sizeBytes),
    ).toBeGreaterThan(0);
    expect(event?.result).not.toContain(absent);
    expect(message).not.toContain(absent);
    expect(message).not.toContain("BEGIN_UNTRUSTED_CHILD_RESULT");
    expect(message).not.toContain("END_UNTRUSTED_CHILD_RESULT");
    expect(message).not.toContain("summarize or re-emit raw");
  });

  it("normalizes latestRawText fallback before parent injection", async () => {
    const rawToolBody = [
      "diff --git a/src/private.ts b/src/private.ts",
      "@@ -1,2 +1,3 @@",
      "+export const sentinel = 'DO_NOT_INJECT_PARENT_LATEST_RAW';",
      "-export const oldValue = true;",
    ].join("\n");
    callGatewayMock.mockImplementation(async (req: unknown) => {
      const typed = req as AgentCallRequest;
      if (typed.method === "agent") {
        return await agentSpy(typed);
      }
      if (typed.method === "chat.history") {
        return {
          messages: [
            {
              role: "toolResult",
              content: { output: rawToolBody },
            },
          ],
        };
      }
      if (typed.method === "agent.wait") {
        return { status: "ok", startedAt: 10, endedAt: 20 };
      }
      return {};
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:latest-raw-wave2",
      childRunId: "run-wave2-latest-raw",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "telegram", to: "-100123", accountId: "default" },
      task: "latest raw fallback wave2",
      timeoutMs: 10,
      cleanup: "keep",
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    const agentCall = requireAgentCall();
    const message = String(agentCall.params?.message ?? "");
    const event = (
      agentCall.params?.internalEvents as
        | Array<{
            result?: string;
            statusCard?: Record<string, unknown> & { quarantine?: Record<string, unknown> };
          }>
        | undefined
    )?.[0];
    const statusCard = event?.statusCard;

    expect(statusCard).toMatchObject({
      normalizedState: "MALFORMED",
      deliveryState: "quarantined",
      contractVerdict: "MALFORMED_RAW_SOURCE_OUTPUT",
      acceptanceEligible: false,
      rawBodySuppressed: true,
      notAcceptanceEvidence: true,
    });
    expect(statusCard?.quarantine?.artifactId ?? statusCard?.quarantine?.path).toBeTruthy();
    expect(event?.result).not.toContain("DO_NOT_INJECT_PARENT_LATEST_RAW");
    expect(message).not.toContain("DO_NOT_INJECT_PARENT_LATEST_RAW");
    expect(message).not.toContain("diff --git");
  });

  it("maps empty output to NO_OUTPUT metadata without raw fallback injection", async () => {
    readLatestAssistantReplyMock.mockResolvedValue("");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:empty-wave2",
      childRunId: "run-wave2-empty",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "telegram", to: "-100123", accountId: "default" },
      task: "empty wave2",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    const agentCall = requireAgentCall();
    const message = String(agentCall.params?.message ?? "");
    const event = (
      agentCall.params?.internalEvents as
        | Array<{
            result?: string;
            statusCard?: Record<string, unknown>;
          }>
        | undefined
    )?.[0];
    const labels = event?.statusCard?.classificationLabels as string[] | undefined;

    expect(event?.statusCard).toMatchObject({
      normalizedState: "MALFORMED",
      contractVerdict: "MISSING_VERDICT_SCHEMA",
      acceptanceEligible: false,
      rawBodySuppressed: true,
      notAcceptanceEvidence: true,
    });
    expect(labels).toContain("NO_OUTPUT");
    expect(event?.result).toContain("NO_OUTPUT");
    expect(message).toContain("NO_OUTPUT");
    expect(message).not.toContain("raw subagent reply");
    expect(message).not.toContain("NO_REPLY");
  });

  it("uses the same metadata-only event shape on queued requester handoff paths", async () => {
    loadSessionStoreMock.mockImplementation(() => ({
      "agent:main:main": {
        sessionId: "session-wave2-queued",
        updatedAt: Date.now(),
        origin: { provider: "discord" },
      },
    }));
    isEmbeddedPiRunActiveMock.mockReturnValue(true);
    queueEmbeddedPiMessageWithOutcomeMock.mockImplementation((sessionId: string) => ({
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
    }));

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:queued-wave2",
      childRunId: "run-wave2-queued",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "queued wave2",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      outcome: { status: "ok" },
      roundOneReply: JSON.stringify({ verdict: "FAIL", failures: 1 }),
    });

    expect(didAnnounce).toBe(true);
    const queuedCall = requireQueuedMessageCall();
    const queuedMessage = String(queuedCall[1]);
    expect(queuedMessage).toContain("Task completion status card");
    expect(queuedMessage).toContain('"normalizedState": "FAIL"');
    expect(queuedMessage).toContain('"notAcceptanceEvidence": true');
    expect(queuedMessage).toContain('"rawBodySuppressed": true');
    expect(queuedMessage).not.toContain("BEGIN_UNTRUSTED_CHILD_RESULT");
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("builds duplicate completion status cards as user-visible suppression data", () => {
    const decision = buildChildCompletionDeliveryDecision({
      classification: {
        transportOutcome: "completed",
        contractVerdict: CHILD_RESULT_DUPLICATE_COMPLETION,
        acceptanceEligible: false,
        reasons: ["DUPLICATE_COMPLETION"],
        safeSummary: "duplicate",
      },
      rawBodySuppressed: true,
      outcome: { status: "ok" },
      requesterIsSubagent: false,
      announceType: "subagent task",
    });

    expect(decision.statusCard).toMatchObject({
      deliveryState: "suppressed_duplicate",
      action: "suppress_user_visible_delivery",
      contractVerdict: CHILD_RESULT_DUPLICATE_COMPLETION,
      acceptanceEligible: false,
      rawBodySuppressed: true,
      userVisibleSuppressed: true,
      userVisibleSuppressedReason: "DUPLICATE_COMPLETION",
      presentation: {
        mode: "status_card",
        ordinaryChatBubble: "suppressed",
        collapsedByDefault: true,
        severity: "muted",
      },
    });
    expect(decision.statusCard.labels).toEqual(
      expect.arrayContaining(["DUPLICATE_ANNOUNCE_SUPPRESSED", "NOT_ACCEPTANCE_EVIDENCE"]),
    );
    expect(decision.statusCard).not.toHaveProperty("delivery");
    expect(decision.statusCard).not.toHaveProperty("suppression");
    expect(decision.replyInstruction).not.toContain("NO_REPLY");
    expect(decision.replyInstruction).not.toContain("ready for user delivery");
    expect(decision.statusLabel).toBe("duplicate completion suppressed");
    expect(JSON.stringify(decision.statusCard)).not.toContain("bodyPreview");
  });

  it("does not present schema-valid but unverified PASS status cards as success", () => {
    const decision = buildChildCompletionDeliveryDecision({
      classification: {
        schemaVersion: 1,
        normalizedState: "UNVERIFIED",
        classificationLabels: ["SCHEMA_VALID", "EVIDENCE_UNVERIFIED"],
        transportOutcome: "completed",
        contractVerdict: "EVIDENCE_UNVERIFIED",
        acceptanceEligible: false,
        reasons: ["PARENT_RUNTIME_EVIDENCE_MISSING"],
        safeSummary:
          "schemaValid=true\nnormalizedState=UNVERIFIED\ncontractVerdict=EVIDENCE_UNVERIFIED",
        sanitizedMetadata: {
          schemaVersion: 1,
          normalizedState: "UNVERIFIED",
          contractVerdict: "EVIDENCE_UNVERIFIED",
          acceptanceEligible: false,
          classificationLabels: ["SCHEMA_VALID", "EVIDENCE_UNVERIFIED"],
          reasons: ["PARENT_RUNTIME_EVIDENCE_MISSING"],
          transportOutcome: "completed",
        },
        evidenceVerifier: {
          decision: "EVIDENCE_UNVERIFIED",
          acceptanceEligible: false,
          parentObserved: false,
          reasons: ["PARENT_RUNTIME_EVIDENCE_MISSING"],
        },
        parsedReport: {
          schemaVersion: 1,
          parserMode: "strict_json",
          strictJson: true,
          schemaValid: true,
          normalizedState: "UNVERIFIED",
          classificationLabels: ["SCHEMA_VALID"],
          verdict: "PASS",
          outputArtifactPaths: ["/tmp/wave3-report.json"],
          outputArtifacts: [{ path: "/tmp/wave3-report.json" }],
          changedPaths: [],
          sourcePaths: [],
          commandsRun: [],
        },
      },
      rawBodySuppressed: true,
      outcome: { status: "ok" },
      requesterIsSubagent: false,
      announceType: "subagent task",
    });

    expect(decision.statusLabel).toBe("child result not accepted; validation required");
    expect(decision.statusCard).toMatchObject({
      normalizedState: "UNVERIFIED",
      schemaValid: true,
      notAcceptanceEvidence: true,
      verifierDecision: "EVIDENCE_UNVERIFIED",
      deliveryState: "validation_required",
      action: "validate_artifact_or_retry",
      acceptanceEligible: false,
      userVisibleSuppressed: true,
      presentation: {
        mode: "status_card",
        ordinaryChatBubble: "suppressed",
        collapsedByDefault: true,
        severity: "warning",
      },
      dashboard: {
        semanticStatus: "warning",
        normalizedState: "UNVERIFIED",
        acceptanceEligible: false,
        notSuccessUnlessVerified: true,
      },
      evidenceVerifier: {
        decision: "EVIDENCE_UNVERIFIED",
        parentObserved: false,
      },
    });
    expect(decision.statusCard.labels).toEqual(
      expect.arrayContaining(["UNVERIFIED", "EVIDENCE_UNVERIFIED", "NOT_ACCEPTANCE_EVIDENCE"]),
    );
    expect(decision.statusCard.presentation?.severity).not.toBe("success");
    expect(decision.statusCard.dashboard?.semanticStatus).not.toBe("success");
    expect(decision.replyInstruction).toContain("not accepted by contract");
    expect(decision.replyInstruction).not.toContain("verified completion");
  });

  it("suppresses late duplicate completion delivery with structured status-card metadata", async () => {
    subagentRegistryRuntimeMock.getLatestSubagentRunByChildSessionKey.mockReturnValue({
      runId: "run-duplicate-status-card",
      completionAnnouncedAt: 123,
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:duplicate",
      childRunId: "run-duplicate-status-card",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "telegram", to: "-100123", accountId: "default" },
      task: "duplicate status card",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "raw duplicate body DO_NOT_INJECT_PARENT",
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    const agentCall = requireAgentCall();
    const message = String(agentCall.params?.message ?? "");
    const event = (
      agentCall.params?.internalEvents as
        | Array<{
            result?: string;
            statusCard?: Record<string, unknown>;
          }>
        | undefined
    )?.[0];
    const statusCard = event?.statusCard;

    expect(agentCall.params?.deliver).toBe(false);
    expect(event?.result).not.toContain("raw duplicate body");
    expect(message).not.toContain("raw duplicate body");
    expect(message).not.toContain("DO_NOT_INJECT_PARENT");
    expect(message).not.toContain("NO_REPLY");
    expect(message).not.toContain("ready for user delivery");
    expect(statusCard).toMatchObject({
      deliveryState: "suppressed_duplicate",
      action: "suppress_user_visible_delivery",
      contractVerdict: CHILD_RESULT_DUPLICATE_COMPLETION,
      acceptanceEligible: false,
      rawBodySuppressed: true,
      userVisibleSuppressed: true,
      userVisibleSuppressedReason: "DUPLICATE_COMPLETION",
    });
    expect(statusCard).not.toHaveProperty("delivery");
    expect(statusCard).not.toHaveProperty("suppression");
    expect(event).not.toHaveProperty("suppression");
  });

  it("deduplicates repeated duplicate completion replays into one compact parent event", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wave4-dedupe-"));
    const previous = process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR;
    process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR = path.join(tmpRoot, "quarantine");
    subagentRegistryRuntimeMock.getLatestSubagentRunByChildSessionKey.mockReturnValue({
      runId: "run-duplicate-replay",
      completionAnnouncedAt: 123,
    });

    try {
      for (let index = 0; index < 3; index += 1) {
        await expect(
          runSubagentAnnounceFlow({
            childSessionKey: "agent:main:subagent:duplicate-replay",
            childRunId: "run-duplicate-replay",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            requesterOrigin: { channel: "telegram", to: "-100123", accountId: "default" },
            task: "duplicate replay status card",
            timeoutMs: 10,
            cleanup: "keep",
            waitForCompletion: false,
            startedAt: 10,
            endedAt: 20,
            outcome: { status: "ok" },
            roundOneReply: "raw duplicate replay DO_NOT_INJECT_PARENT",
            expectsCompletionMessage: true,
          }),
        ).resolves.toBe(true);
      }

      expect(agentSpy).toHaveBeenCalledTimes(1);
      const agentCall = requireAgentCall();
      const message = String(agentCall.params?.message ?? "");
      const event = (
        agentCall.params?.internalEvents as
          | Array<{
              result?: string;
              statusCard?: Record<string, unknown> & {
                quarantine?: {
                  path?: string;
                  sha256?: string;
                  artifactId?: string;
                  payloadHash?: string;
                  byteCount?: number;
                  sizeBytes?: number;
                };
                dedupe?: Record<string, unknown>;
              };
            }>
          | undefined
      )?.[0];
      const statusCard = event?.statusCard;
      expect(statusCard).toMatchObject({
        deliveryState: "suppressed_duplicate",
        action: "suppress_user_visible_delivery",
        contractVerdict: CHILD_RESULT_DUPLICATE_COMPLETION,
        acceptanceEligible: false,
        rawBodySuppressed: true,
        dedupe: {
          duplicate: true,
          seenCount: 2,
          duplicateCount: 1,
          parentEventSuppressed: false,
        },
      });
      expect(String(statusCard?.dedupe?.key ?? "")).toContain("childRunId=run-duplicate-replay");
      expect(String(statusCard?.dedupe?.resultHash ?? "")).toMatch(/^[a-f0-9]{64}$/);
      expect(statusCard?.quarantine?.artifactId ?? statusCard?.quarantine?.path).toMatch(/^q_/);
      expect(statusCard?.quarantine?.payloadHash ?? statusCard?.quarantine?.sha256).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(
        statusCard?.quarantine?.byteCount ?? statusCard?.quarantine?.sizeBytes,
      ).toBeGreaterThan(0);
      expect(event?.result).not.toContain("DO_NOT_INJECT_PARENT");
      expect(message).not.toContain("DO_NOT_INJECT_PARENT");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR;
      } else {
        process.env.OPENCLAW_CHILD_RESULT_QUARANTINE_DIR = previous;
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("suppresses recovered duplicate replay when persisted counters already saw a compact event", async () => {
    subagentRegistryRuntimeMock.getLatestSubagentRunByChildSessionKey.mockReturnValue({
      runId: "run-recovered-duplicate",
      completionAnnouncedAt: 789,
    });
    subagentRegistryRuntimeMock.beginSubagentCompletionDedupe.mockReturnValue({
      duplicate: true,
      counters: { seenCount: 4, duplicateCount: 2 },
    });
    const onDeliveryResult = vi.fn();

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:recovered-duplicate",
      childRunId: "run-recovered-duplicate",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "telegram", to: "-100123", accountId: "default" },
      task: "recovered duplicate replay",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      outcome: { status: "ok" },
      roundOneReply: "raw recovered duplicate DO_NOT_INJECT_PARENT",
      expectsCompletionMessage: true,
      onDeliveryResult,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).not.toHaveBeenCalled();
    expect(onDeliveryResult).toHaveBeenCalledWith({ delivered: true, path: "none" });
  });

  it("backgrounds stale-task duplicate completions so they cannot satisfy current output", async () => {
    subagentRegistryRuntimeMock.getLatestSubagentRunByChildSessionKey.mockReturnValue({
      runId: "run-stale-duplicate",
      completionAnnouncedAt: 456,
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:stale-duplicate",
      childRunId: "run-stale-duplicate",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "telegram", to: "-100123", accountId: "default" },
      task: "stale duplicate status card",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      outcome: { status: "ok" },
      roundOneReply: JSON.stringify({ verdict: "PASS" }),
      expectsCompletionMessage: true,
      activeTaskContract: {
        taskId: "current-task",
        currentUserRequest: "Current task only.",
        inputArtifacts: [],
        expectedOutputArtifacts: [],
        allowedSideEffects: [],
        authorizationSource: { kind: "test", reference: "current" },
        nonGoals: [],
      },
      childTaskId: "stale-task",
    });

    expect(didAnnounce).toBe(true);
    const event = (
      requireAgentCall().params?.internalEvents as
        | Array<{
            result?: string;
            statusCard?: Record<string, unknown> & { dedupe?: Record<string, unknown> };
          }>
        | undefined
    )?.[0];
    expect(event?.statusCard).toMatchObject({
      deliveryState: "suppressed_duplicate",
      contractVerdict: CHILD_RESULT_DUPLICATE_COMPLETION,
      acceptanceEligible: false,
      reasons: ["DUPLICATE_COMPLETION", "CHILD_TASK_ID_MISMATCH"],
      dedupe: {
        activeTaskContractId: "current-task",
        taskId: "stale-task",
        duplicate: true,
      },
    });
    expect(event?.result).toContain("currentTaskOutput=false");
    expect(event?.result).toContain("backgrounded=true");
  });

  it("suppresses ANNOUNCE_SKIP delivery while still deleting the child session", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-skip-whitespace",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 10,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "  ANNOUNCE_SKIP  ",
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).not.toHaveBeenCalled();
    expect(sessionsDeleteSpy).toHaveBeenCalledTimes(1);
    expect(sessionsDeleteSpy).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:test",
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  });

  it("keeps lifecycle hooks enabled when deleting a completed session-mode child session", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-session-delete-cleanup",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "thread-bound cleanup",
      timeoutMs: 10,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "completed",
      spawnMode: "session",
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    expect(sessionsDeleteSpy).toHaveBeenCalledTimes(1);
    expect(sessionsDeleteSpy).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:test",
        deleteTranscript: true,
        emitLifecycleHooks: true,
      },
      timeoutMs: 10_000,
    });
  });

  it("uses origin.provider for channel-specific queue settings in active announce delivery", async () => {
    mockConfig = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      messages: {
        queue: {
          byChannel: {
            discord: "followup",
          },
        },
      },
    };
    loadSessionStoreMock.mockImplementation(() => ({
      "agent:main:main": {
        sessionId: "session-origin-provider-steer",
        updatedAt: Date.now(),
        origin: { provider: "discord" },
      },
    }));
    isEmbeddedPiRunActiveMock.mockReturnValue(true);
    queueEmbeddedPiMessageWithOutcomeMock.mockImplementation((sessionId: string) => ({
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
    }));

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-origin-provider-steer",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "FAILED (failures=1)",
    });

    expect(didAnnounce).toBe(true);
    const queuedCall = requireQueuedMessageCall();
    expect(queuedCall?.[0]).toBe("session-origin-provider-steer");
    expect(queuedCall?.[1]).toContain("[Internal task completion event]");
    expect(queuedCall?.[1]).toContain("task: do thing");
    expect(queuedCall?.[2]).toEqual({ steeringMode: "all" });
    expect(agentSpy).not.toHaveBeenCalled();
  });

  it("keeps completion direct announce session-only when requester origin is webchat", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:webchat",
      childRunId: "run-webchat-direct-announce",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: {
        channel: "webchat",
        to: "chat:123",
        accountId: "default",
      },
      task: "deliver completion",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const agentCall = requireAgentCall();
    expect(agentCall.method).toBe("agent");
    expect(agentCall.params?.sessionKey).toBe("agent:main:main");
    expect(agentCall.params?.deliver).toBe(false);
    expect(agentCall.params?.bestEffortDeliver).toBe(true);
    expect(agentCall.params?.accountId).toBe("default");
  });

  it("keeps nested subagent completion announces channel-less in session-only mode", async () => {
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-nested-subagent-direct-announce",
      requesterSessionKey: "agent:main:subagent:orchestrator",
      requesterDisplayKey: "orchestrator",
      requesterOrigin: {
        channel: "telegram",
        to: "-100123",
        accountId: "default",
      },
      task: "deliver nested completion",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const params = requireAgentCall().params ?? {};
    expect(params.sessionKey).toBe("agent:main:subagent:orchestrator");
    expect(params.deliver).toBe(false);
    expect(params.bestEffortDeliver).toBe(true);
    expect(params.channel).toBeUndefined();
    expect(params.to).toBeUndefined();
    expect(params.accountId).toBeUndefined();
    expect(params.threadId).toBeUndefined();
  });

  it("falls back to stored delivery target when mocked completion origins omit to", async () => {
    loadSessionStoreMock.mockImplementation(() => ({
      "agent:main:main": {
        sessionId: "session-tg-group",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "-1001234567890",
        lastAccountId: "bot:123",
      },
    }));

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:tg",
      childRunId: "run-tg-group-completion",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "telegram" },
      requesterDisplayKey: "main",
      task: "telegram group task",
      timeoutMs: 10,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "FAILED (failures=1)",
      expectsCompletionMessage: true,
    });

    expect(didAnnounce).toBe(true);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const agentCall = requireAgentCall();
    expect(agentCall.params?.deliver).toBe(true);
    expect(agentCall.params?.channel).toBe("telegram");
    expect(agentCall.params?.accountId).toBe("bot-123");
    expect(agentCall.params?.to).toBe("-1001234567890");
  });
});
