import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, type Mock, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.public.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { upsertSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { createHookRunner, type HookRunner } from "../plugins/hooks.js";
import { createLazyPluginRuntime } from "../plugins/loader-module-runtime.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import type { RunCliAgentParams } from "./cli-runner/types.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

export async function createClaimedReplySessionTarget(
  root: string,
  params: { agentId: string; sessionId: string; sessionKey: string },
) {
  const target = {
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: path.join(root, "agents", params.agentId, "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  return target;
}

function selectClaimedReplyAssistantEvents(
  events: Awaited<ReturnType<typeof loadTranscriptEvents>>,
) {
  return events.filter(
    (event) => isRecord(event) && isRecord(event.message) && event.message.role === "assistant",
  );
}

export function registerCliClaimedReplyAuthorityTests(params: {
  assertNoBackendExecution: () => void;
  baseRunParams: Omit<RunCliAgentParams, "admittedRunContext"> & {
    agentId: string;
    sessionId: string;
    sessionKey: string;
  };
  hasHooksMock: Mock<(hookName: string) => boolean>;
  makeTempDir: (prefix: string) => string;
  runBeforeAgentReplyMock: Mock<HookRunner["runBeforeAgentReply"]>;
  runCliAgent: (
    runParams: Omit<RunCliAgentParams, "admittedRunContext">,
  ) => Promise<EmbeddedAgentRunResult>;
}) {
  it.each([
    { name: "absent reply", reply: undefined },
    { name: "explicit silent reply", reply: { text: SILENT_REPLY_TOKEN } },
    { name: "heartbeat acknowledgment", reply: { text: HEARTBEAT_TOKEN } },
  ])("keeps a $name cron hook claim out of the assistant transcript", async ({ reply }) => {
    const sessionTarget = await createClaimedReplySessionTarget(
      params.makeTempDir("openclaw-cli-before-agent-reply-silent-"),
      params.baseRunParams,
    );
    params.hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    params.runBeforeAgentReplyMock.mockResolvedValue({ handled: true, reply });
    const result = await params.runCliAgent({
      ...params.baseRunParams,
      ...sessionTarget,
      trigger: "cron",
      jobId: "cron-job-123",
      persistAssistantTranscript: true,
    });
    params.assertNoBackendExecution();
    expect(result.payloads?.[0]?.text).toBe(reply?.text ?? SILENT_REPLY_TOKEN);
    expect(selectClaimedReplyAssistantEvents(await loadTranscriptEvents(sessionTarget))).toEqual(
      [],
    );
  });

  it("does not persist a claimed reply after cancellation during the hook", async () => {
    const sessionTarget = await createClaimedReplySessionTarget(
      params.makeTempDir("openclaw-cli-before-agent-reply-cancelled-"),
      params.baseRunParams,
    );
    const entered = createDeferred();
    const release = createDeferred();
    const abort = new AbortController();
    const failure = new Error("cancelled while the hook was pending");
    params.hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    params.runBeforeAgentReplyMock.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { handled: true, reply: { text: "late claimed reply" } };
    });
    const outcome = params
      .runCliAgent({
        ...params.baseRunParams,
        ...sessionTarget,
        abortSignal: abort.signal,
        persistAssistantTranscript: true,
        trigger: "user",
      })
      .catch((error: unknown) => error);
    await entered.promise;
    abort.abort(failure);
    release.resolve();
    const settled = await outcome;
    expect(selectClaimedReplyAssistantEvents(await loadTranscriptEvents(sessionTarget))).toEqual(
      [],
    );
    expect(settled).toBe(failure);
  });

  it.each(["during", "after"] as const)(
    "does not persist a claimed reply cancelled %s transcript preparation",
    async (cancellationTiming) => {
      const sessionTarget = await createClaimedReplySessionTarget(
        params.makeTempDir("openclaw-cli-before-agent-reply-write-cancelled-"),
        params.baseRunParams,
      );
      const abort = new AbortController();
      const failure = new Error("cancelled while transcript write was preparing");
      let prepared = 0;
      params.hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
      params.runBeforeAgentReplyMock.mockResolvedValue({
        handled: true,
        reply: { text: "late claimed reply" },
      });

      const outcome = await params
        .runCliAgent({
          ...params.baseRunParams,
          ...sessionTarget,
          abortSignal: abort.signal,
          persistAssistantTranscript: true,
          trigger: "user",
          prepareAssistantTranscriptMessage: (message) => {
            prepared += 1;
            if (cancellationTiming === "during") {
              abort.abort(failure);
            } else {
              queueMicrotask(() => abort.abort(failure));
            }
            return message;
          },
        })
        .catch((error: unknown) => error);

      expect(prepared).toBe(1);
      expect(selectClaimedReplyAssistantEvents(await loadTranscriptEvents(sessionTarget))).toEqual(
        [],
      );
      expect(outcome).toBe(failure);
    },
  );
}

export function createRegisteredBeforeAgentReplyFixture(reply: ReplyPayload) {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createLazyPluginRuntime({}),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "claimed-reply-proof", origin: "bundled" });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  const handler = vi.fn(() => ({ handled: true as const, reply }));
  api.on("before_agent_reply", handler);
  const sendText = vi.fn<NonNullable<ChannelOutboundAdapter["sendText"]>>(async () => ({
    channel: "slack",
    messageId: "claimed-text-delivered",
  }));
  const sendMedia = vi.fn<NonNullable<ChannelOutboundAdapter["sendMedia"]>>(async () => ({
    channel: "slack",
    messageId: "claimed-media-delivered",
  }));
  const sendPayload = vi.fn<NonNullable<ChannelOutboundAdapter["sendPayload"]>>(async () => ({
    channel: "slack",
    messageId: "claimed-payload-delivered",
  }));
  api.registerChannel({
    plugin: {
      ...createChannelTestPluginBase({
        id: "slack",
        label: "Slack",
        config: { listAccountIds: () => [], resolveAccount: () => ({}) },
      }),
      outbound: { deliveryMode: "direct", sendText, sendMedia, sendPayload },
    },
  });
  return {
    registry: builder.registry,
    hookRunner: createHookRunner(builder.registry),
    handler,
    sendText,
    sendMedia,
    sendPayload,
  };
}

export async function expectClaimedReplyPersisted(params: {
  result: { payloads?: ReplyPayload[] };
  reply: ReplyPayload;
  transcript: string | null;
  sessionTarget: Parameters<typeof loadTranscriptEvents>[0];
  runId: string;
}): Promise<{
  payload: ReplyPayload;
  beforeDelivery: Awaited<ReturnType<typeof loadTranscriptEvents>>;
}> {
  const payload = expectDefined(params.result.payloads?.[0], "expected claimed reply payload");
  expect(payload).toMatchObject(params.reply);
  const events = await loadTranscriptEvents(params.sessionTarget);
  const assistantMessages = selectClaimedReplyAssistantEvents(events);
  if (params.transcript === null) {
    expect(assistantMessages).toHaveLength(0);
  } else {
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: params.transcript }),
          ]),
        }),
      }),
    );
  }
  expect(getReplyPayloadMetadata(payload)).toMatchObject({
    assistantTranscriptOwned: true,
    heartbeatScratchProposal: "preserved plugin metadata",
  });
  if (params.transcript === null) {
    expect(getReplyPayloadMetadata(payload)?.assistantTranscriptIdempotencyKey).toBeUndefined();
  } else {
    expect(getReplyPayloadMetadata(payload)?.assistantTranscriptIdempotencyKey).toBe(
      `cli-assistant:${params.runId}`,
    );
  }
  return { payload, beforeDelivery: events };
}

export function expectClaimedReplyDelivered(params: {
  reply: ReplyPayload;
  expectedDeliveryText?: string;
  sendText: Mock<NonNullable<ChannelOutboundAdapter["sendText"]>>;
  sendMedia: Mock<NonNullable<ChannelOutboundAdapter["sendMedia"]>>;
  sendPayload: Mock<NonNullable<ChannelOutboundAdapter["sendPayload"]>>;
}): void {
  const mediaUrls = params.reply.mediaUrls?.length
    ? params.reply.mediaUrls
    : params.reply.mediaUrl
      ? [params.reply.mediaUrl]
      : [];
  if (params.reply.location || params.reply.channelData) {
    expect(params.sendText).not.toHaveBeenCalled();
    expect(params.sendMedia).not.toHaveBeenCalled();
    expect(params.sendPayload).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        payload: expect.objectContaining(
          params.reply.location
            ? { location: params.reply.location }
            : { channelData: params.reply.channelData },
        ),
      }),
    );
    return;
  }
  expect(params.sendPayload).not.toHaveBeenCalled();
  if (mediaUrls.length > 0) {
    expect(params.sendText).not.toHaveBeenCalled();
    expect(params.sendMedia).toHaveBeenCalledTimes(mediaUrls.length);
    expect(params.sendMedia.mock.calls.map(([context]) => context.mediaUrl)).toEqual(mediaUrls);
    expect(params.sendMedia.mock.calls[0]?.[0].text).toBe(
      params.expectedDeliveryText ?? params.reply.text ?? "",
    );
    return;
  }
  expect(params.sendMedia).not.toHaveBeenCalled();
  expect(params.sendText).toHaveBeenCalledTimes(1);
  expect(params.sendText).toHaveBeenCalledWith(
    expect.objectContaining({ text: params.expectedDeliveryText ?? params.reply.text }),
  );
}
