// Full-entry coverage for before_agent_reply hook handling before embedded attempts.
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { captureGuardedFetchRequestAuthority } from "../../infra/net/fetch-request-authority.js";
import { withBeforeAgentReplyObserver } from "../../plugins/before-agent-reply.js";
import { readClaimingHookAdmission } from "../../plugins/hook-claim-admission.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

function firstBeforeAgentReplyCall() {
  // Helper keeps assertions on the hook payload and context close to the tests
  // without leaking mock tuple details into every case.
  const call = mockedGlobalHookRunner.runBeforeAgentReply.mock.calls[0];
  if (!call) {
    throw new Error("expected before_agent_reply hook call");
  }
  return call;
}

async function prepareHookSession(sessionKey: string) {
  const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
  const sessionTarget = {
    agentId: "main",
    sessionId: "hook-admitted-run",
    sessionKey,
    storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    expectedLifecycleRevision: "hook-admitted-revision",
  };
  await replaceSessionEntry(sessionTarget, {
    sessionId: sessionTarget.sessionId,
    lifecycleRevision: sessionTarget.expectedLifecycleRevision,
    updatedAt: 1,
  });
  return {
    ...createOverflowRunParams(state),
    sessionId: sessionTarget.sessionId,
    sessionKey,
    sessionTarget,
    trigger: "cron" as const,
  };
}

describe("runEmbeddedAgent before_agent_reply seam", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.before-agent-reply-cron" });
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it.each(
    [
      {
        name: "persistent user turn",
        sessionPersistence: undefined,
        currentInboundEventKind: undefined,
        persists: true,
      },
      {
        name: "detached user turn",
        sessionPersistence: "detached" as const,
        currentInboundEventKind: undefined,
        persists: false,
      },
      {
        name: "room event",
        sessionPersistence: undefined,
        currentInboundEventKind: "room_event" as const,
        persists: false,
      },
    ].flatMap((testCase) =>
      [
        { name: "text", reply: { text: "user turn claimed" }, expected: "user turn claimed" },
        {
          name: "media only",
          reply: { mediaUrl: "https://example.com/photo.png?token=redacted" },
          expected: "photo.png",
        },
        {
          name: "captioned media",
          reply: { text: "caption", mediaUrl: "https://example.com/photo.png" },
          expected: "caption\nphoto.png",
        },
        {
          name: "silent token with media",
          reply: { text: SILENT_REPLY_TOKEN, mediaUrl: "https://example.com/photo.png" },
          expected: "photo.png",
        },
        {
          name: "mixed silent token text",
          reply: { text: `Hello ${SILENT_REPLY_TOKEN}` },
          expected: "Hello",
        },
        {
          name: "mixed silent token with media",
          reply: { text: `Hello ${SILENT_REPLY_TOKEN}`, mediaUrl: "https://example.com/photo.png" },
          expected: "Hello\nphoto.png",
        },
        {
          name: "mixed heartbeat token text",
          reply: { text: `Hello ${HEARTBEAT_TOKEN}` },
          expected: "Hello",
        },
        {
          name: "mixed heartbeat token media",
          reply: { text: `Hello ${HEARTBEAT_TOKEN}`, mediaUrl: "https://example.com/photo.png" },
          expected: "Hello\nphoto.png",
        },
        {
          name: "heartbeat token media",
          reply: { text: HEARTBEAT_TOKEN, mediaUrl: "https://example.com/photo.png" },
          expected: "photo.png",
        },
        {
          name: "heartbeat token location",
          reply: {
            text: HEARTBEAT_TOKEN,
            location: { latitude: 48.858844, longitude: 2.294351 },
          },
          expected: "📍 48.858844, 2.294351",
        },
        {
          name: "heartbeat token with opaque channel data",
          reply: {
            text: HEARTBEAT_TOKEN,
            channelData: {
              slack: { blocks: [{ type: "section", text: { type: "plain_text", text: "Hello" } }] },
            },
          },
          expected: null,
        },
        {
          name: "silent token with opaque channel data",
          reply: {
            text: SILENT_REPLY_TOKEN,
            channelData: {
              slack: { blocks: [{ type: "section", text: { type: "plain_text", text: "Hello" } }] },
            },
          },
          expected: null,
        },
        {
          name: "multiple media",
          reply: {
            text: "caption",
            mediaUrls: ["https://example.com/photo.png", "https://example.com/report.pdf"],
            mediaUrl: "https://example.com/ignored.png",
          },
          expected: "caption\nphoto.png, report.pdf",
        },
      ].map((mediaCase) =>
        Object.assign({}, testCase, mediaCase, {
          name: `${testCase.name} with ${mediaCase.name}`,
        }),
      ),
    ),
  )("keeps hook-claimed $name transcript ownership", async (testCase) => {
    const session = await createSharedRunIntegrationSession();
    const { loadTranscriptEvents } = await import("../../config/sessions/session-accessor.js");
    const { getReplyPayloadMetadata, setReplyPayloadMetadata } =
      await import("../../auto-reply/reply-payload.js");
    const { createRegisteredBeforeAgentReplyFixture } =
      await import("../before-agent-reply.test-support.js");
    try {
      const { hookRunner, handler } = createRegisteredBeforeAgentReplyFixture(
        setReplyPayloadMetadata({ ...testCase.reply }, { blockSourceText: "plugin-owned source" }),
      );
      mockedGlobalHookRunner.hasHooks.mockImplementation(
        (hookName: string) => hookName === "before_agent_reply" && hookRunner.hasHooks(hookName),
      );
      mockedGlobalHookRunner.runBeforeAgentReply.mockImplementation(hookRunner.runBeforeAgentReply);

      const result = await runEmbeddedAgent({
        ...session.runParams,
        trigger: "user",
        sessionPersistence: testCase.sessionPersistence,
        currentInboundEventKind: testCase.currentInboundEventKind,
      });

      expect(result.payloads?.[0]).toEqual(testCase.reply);
      expect(handler).toHaveBeenCalledOnce();
      expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
      const transcript = await loadTranscriptEvents(session.runParams.sessionTarget);
      const metadata = getReplyPayloadMetadata(result.payloads?.[0] ?? {});
      expect(metadata).toMatchObject({
        assistantTranscriptOwned: true,
        blockSourceText: "plugin-owned source",
      });
      if (testCase.persists && testCase.expected !== null) {
        expect(
          transcript.filter(
            (event) =>
              isRecord(event) && isRecord(event.message) && event.message.role === "assistant",
          ),
        ).toEqual([
          expect.objectContaining({
            message: expect.objectContaining({
              role: "assistant",
              content: [{ type: "text", text: testCase.expected }],
            }),
          }),
        ]);
        expect(metadata).toMatchObject({
          assistantTranscriptIdempotencyKey: `before-agent-reply:${session.runParams.runId}`,
        });
      } else {
        expect(transcript).toEqual([]);
        expect(metadata?.assistantTranscriptIdempotencyKey).toBeUndefined();
      }
    } finally {
      await session.cleanup();
    }
  });

  it("does not persist a hook reply after its session writer is replaced", async () => {
    const session = await createSharedRunIntegrationSession();
    const { loadTranscriptEvents } = await import("../../config/sessions/session-accessor.js");
    const { claimAgentSessionWriter } = await import("./run/session-bootstrap.js");
    try {
      mockedGlobalHookRunner.hasHooks.mockImplementation(
        (hookName: string) => hookName === "before_agent_reply",
      );
      mockedGlobalHookRunner.runBeforeAgentReply.mockImplementationOnce(async () => {
        await claimAgentSessionWriter({
          ...session.runParams,
          runId: "replacement-writer",
        });
        return { handled: true, reply: { text: "stale writer reply" } };
      });

      await runEmbeddedAgent({ ...session.runParams, trigger: "user" });

      expect(mockedGlobalHookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(1);
      expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
      expect(await loadTranscriptEvents(session.runParams.sessionTarget)).toEqual([]);
    } finally {
      await session.cleanup();
    }
  });

  it.each([
    { name: "absent reply", reply: undefined },
    { name: "explicit silent reply", reply: { text: SILENT_REPLY_TOKEN } },
    { name: "heartbeat acknowledgment", reply: { text: HEARTBEAT_TOKEN } },
  ])("keeps a $name hook claim out of the assistant transcript", async ({ reply }) => {
    const session = await createSharedRunIntegrationSession();
    const { loadTranscriptEvents } = await import("../../config/sessions/session-accessor.js");
    try {
      mockedGlobalHookRunner.hasHooks.mockImplementation(
        (hookName: string) => hookName === "before_agent_reply",
      );
      mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({ handled: true, reply });
      const result = await runEmbeddedAgent({ ...session.runParams, trigger: "user" });
      expect(result.payloads?.[0]?.text).toBe(reply?.text ?? SILENT_REPLY_TOKEN);
      expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
      const assistantMessages = (
        await loadTranscriptEvents(session.runParams.sessionTarget)
      ).filter(
        (event) =>
          isRecord(event) &&
          event.type === "message" &&
          isRecord(event.message) &&
          event.message.role === "assistant",
      );
      expect(assistantMessages).toEqual([]);
    } finally {
      await session.cleanup();
    }
  });

  it("does not persist a claimed reply after cancellation during the hook", async () => {
    const session = await createSharedRunIntegrationSession();
    const { loadTranscriptEvents } = await import("../../config/sessions/session-accessor.js");
    const entered = createDeferred();
    const release = createDeferred();
    const abort = new AbortController();
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { handled: true, reply: { text: "late claimed reply" } };
    });
    try {
      const outcome = runEmbeddedAgent({
        ...session.runParams,
        abortSignal: abort.signal,
        trigger: "user",
      }).catch((error: unknown) => error);
      await entered.promise;
      abort.abort(new Error("cancelled while the hook was pending"));
      release.resolve();
      await outcome;
      const assistantMessages = (
        await loadTranscriptEvents(session.runParams.sessionTarget)
      ).filter(
        (event) =>
          isRecord(event) &&
          event.type === "message" &&
          isRecord(event.message) &&
          event.message.role === "assistant",
      );
      expect(assistantMessages).toEqual([]);
    } finally {
      release.resolve();
      await session.cleanup();
    }
  });

  it.each(["during", "after"] as const)(
    "does not persist a claimed reply cancelled %s transcript preparation",
    async (cancellationTiming) => {
      const session = await createSharedRunIntegrationSession();
      const { loadTranscriptEvents } = await import("../../config/sessions/session-accessor.js");
      const abort = new AbortController();
      let prepared = 0;
      mockedGlobalHookRunner.hasHooks.mockImplementation(
        (hookName: string) => hookName === "before_agent_reply",
      );
      mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
        handled: true,
        reply: { text: "late claimed reply" },
      });

      try {
        const outcome = await runEmbeddedAgent({
          ...session.runParams,
          abortSignal: abort.signal,
          trigger: "user",
          prepareAssistantTranscriptMessage: (message) => {
            prepared += 1;
            const failure = new Error("cancelled while transcript write was preparing");
            if (cancellationTiming === "during") {
              abort.abort(failure);
            } else {
              queueMicrotask(() => abort.abort(failure));
            }
            return message;
          },
        }).catch((error: unknown) => error);

        expect(prepared).toBe(1);
        expect(outcome).toBeInstanceOf(Error);
        const assistantMessages = (
          await loadTranscriptEvents(session.runParams.sessionTarget)
        ).filter(
          (event) =>
            isRecord(event) &&
            event.type === "message" &&
            isRecord(event.message) &&
            event.message.role === "assistant",
        );
        expect(assistantMessages).toEqual([]);
      } finally {
        await session.cleanup();
      }
    },
  );

  it("lets before_agent_reply claim cron runs before the embedded attempt starts", async () => {
    // Cron hooks can fully handle maintenance prompts before the model is
    // invoked, which avoids unnecessary prompt-cache and setup work.
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed" },
    });
    const onExecutionPhase = vi.fn();

    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      trigger: "cron",
      jobId: "cron-job-123",
      prompt: "__openclaw_memory_core_short_term_promotion_dream__",
      onExecutionPhase,
    });

    expect(mockedGlobalHookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(1);
    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "before_agent_reply" }),
    );
    const [hookPayload, hookContext] = firstBeforeAgentReplyCall();
    expect(hookPayload).toEqual({
      cleanedBody: "__openclaw_memory_core_short_term_promotion_dream__",
    });
    expect(hookContext?.jobId).toBe("cron-job-123");
    expect(hookContext?.agentId).toBe("main");
    expect(hookContext?.sessionId).toBe("test-session");
    expect(hookContext?.sessionKey).toBe(createOverflowRunParams(state).sessionKey);
    expect(hookContext?.workspaceDir).toBe(state.workspaceDir);
    expect(hookContext?.trigger).toBe("cron");
    expect(hookContext?.senderId).toBeUndefined();
    expect(hookContext?.chatId).toBeUndefined();
    expect(hookContext?.channel).toBeUndefined();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("dreaming claimed");
  });

  it("passes the heartbeat queue and re-arms setup progress when its hook does not claim", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue(undefined);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());
    const onExecutionPhase = vi.fn();

    await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      trigger: "heartbeat",
      sessionKey: "agent:main:heartbeat:heartbeat",
      heartbeatEventQueueSessionKey: "agent:main:heartbeat",
      onExecutionPhase,
    });

    expect(firstBeforeAgentReplyCall()[1]).toMatchObject({
      sessionKey: "agent:main:heartbeat:heartbeat",
      heartbeatEventQueueSessionKey: "agent:main:heartbeat",
    });
    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "before_agent_reply" }),
    );
    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "runtime_plugins" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "stable cron root", sessionKey: "agent:main:cron:hook-authority", fenced: true },
    { name: "ordinary session", sessionKey: "agent:main:hook-authority", fenced: false },
  ])("retains before-reply authority through a handled hook for $name", async (scenario) => {
    const params = await prepareHookSession(scenario.sessionKey);
    let requestAuthority: (() => void) | undefined;
    let claimAuthority: (() => void) | undefined;
    const effect = vi.fn();
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockImplementation(async (_event, context) => {
      requestAuthority = captureGuardedFetchRequestAuthority();
      claimAuthority = readClaimingHookAdmission(context)?.assertCurrent;
      if (scenario.fenced) {
        expect(requestAuthority).toBeTypeOf("function");
        expect(claimAuthority).toBeTypeOf("function");
        requestAuthority?.();
        claimAuthority?.();
      } else {
        expect(requestAuthority).toBeUndefined();
        expect(claimAuthority).toBeUndefined();
      }
      effect();
      return { handled: true, reply: { text: "hook completed" } };
    });

    const result = await runEmbeddedAgent(params);

    expect(result.payloads).toEqual([{ text: "hook completed" }]);
    expect(effect).toHaveBeenCalledOnce();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    if (scenario.fenced) {
      expect(() => requestAuthority?.()).toThrow("Guarded request authority is no longer active");
      expect(() => claimAuthority?.()).toThrow();
    }
  });

  it("rejects a reassigned cron root before the before-reply hook effect", async () => {
    const params = await prepareHookSession("agent:main:cron:hook-rotation");
    const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
    const effect = vi.fn();
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockImplementation(async () => {
      effect();
      return { handled: true, reply: { text: "stale hook result" } };
    });

    await expect(
      withBeforeAgentReplyObserver(
        {
          beforeDispatch: async () => {
            await replaceSessionEntry(params.sessionTarget, {
              sessionId: "replacement-cron-run",
              lifecycleRevision: "replacement-cron-revision",
              updatedAt: 2,
            });
          },
          afterDispatch: async (result) => result,
        },
        () => runEmbeddedAgent(params),
      ),
    ).rejects.toThrow("The original session generation no longer accepts this delivery");

    expect(effect).not.toHaveBeenCalled();
    expect(mockedGlobalHookRunner.runBeforeAgentReply).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
  });

  it("does not swallow cron-root revocation in a model-selection hook", async () => {
    const params = await prepareHookSession("agent:main:cron:model-hook-rotation");
    const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
    const effect = vi.fn();
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_model_resolve",
    );
    mockedGlobalHookRunner.runBeforeModelResolve.mockImplementationOnce(async () => {
      const assertRequestCurrent = captureGuardedFetchRequestAuthority();
      await replaceSessionEntry(params.sessionTarget, {
        sessionId: "replacement-model-run",
        lifecycleRevision: "replacement-model-revision",
        updatedAt: 2,
      });
      assertRequestCurrent?.();
      effect();
      return undefined;
    });

    await expect(runEmbeddedAgent(params)).rejects.toThrow(
      "The original session generation no longer accepts this delivery",
    );
    expect(mockedGlobalHookRunner.runBeforeModelResolve).toHaveBeenCalledOnce();
    expect(effect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
  });
});
