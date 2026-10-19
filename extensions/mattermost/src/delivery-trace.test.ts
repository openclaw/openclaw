// Real draft/delivery owners with recording REST I/O; the driver mirrors the
// monitor's block-preview callbacks. Refresh with OPENCLAW_TRACE_UPDATE=1.
import {
  deliveryTraceScenarios,
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceScenario,
  type WireRecorder,
} from "openclaw/plugin-sdk/channel-contract-testing";
import {
  createLivePreviewLifecycle,
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { describe, it, vi } from "vitest";
import { createMattermostPost, type MattermostClient } from "./mattermost/client.js";
import { createMattermostDraftStream } from "./mattermost/draft-stream.js";
import { resolveMattermostReplyRootId } from "./mattermost/monitor-context.js";
import { deliverMattermostReplyWithDraftPreview } from "./mattermost/monitor-draft-delivery.js";
import {
  deliverMattermostReplyPayload,
  joinMattermostVisibleContent,
} from "./mattermost/reply-delivery.js";

const CHANNEL_ID = "channel-trace";
const ROOT_ID = "root-trace";
const ACCOUNT_ID = "main";
// Matches the monitor's draft stream wiring (throttleMs: 1200).
const DRAFT_THROTTLE_MS = 1200;

const cfg = {} as OpenClawConfig;
const tableMode = resolveMarkdownTableMode({ cfg, channel: "mattermost" });
const chunkMode = resolveChunkMode(cfg, "mattermost", ACCOUNT_ID);
const textLimit = resolveTextChunkLimit(cfg, "mattermost", ACCOUNT_ID, { fallbackLimit: 4000 });

// deliverMattermostReplyPayload only touches channel.text helpers; bind the
// real implementations the plugin runtime would provide.
const core = {
  channel: {
    text: { convertMarkdownTables, resolveChunkMode, chunkMarkdownTextWithMode },
  },
} as unknown as PluginRuntime;

function createRecordingMattermostClient(recorder: WireRecorder): MattermostClient {
  let postCount = 0;
  const requestImpl = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const method = init?.method ?? "GET";
    const payload =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const record = (
      target: string,
      result: Record<string, string>,
      body?: Record<string, unknown>,
    ) => {
      recorder.recordWireCall({ method: `${method} ${path}`, target, payload: body, result });
      return result as T;
    };
    if (method === "POST" && path === "/posts") {
      return record(
        typeof payload?.channel_id === "string" ? payload.channel_id : "",
        {
          id: `post-${++postCount}`,
        },
        payload,
      );
    }
    const postRoute = /^\/posts\/([^/]+)(\/patch)?$/.exec(path);
    const postId = postRoute?.[1];
    if (postId) {
      if (method === "DELETE" && !postRoute?.[2]) {
        return record(postId, { status: "OK" });
      }
      if (method === "PUT" && postRoute?.[2] === "/patch") {
        return record(postId, { id: postId }, payload);
      }
    }
    throw new Error(`Unexpected Mattermost request: ${method} ${path}`);
  };
  return {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "test-token",
    request: vi.fn(requestImpl) as MattermostClient["request"],
    fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
  };
}

function receiptFor(messageIds: string[], kind: "text" | "preview", replyToId?: string) {
  return createMessageReceiptFromOutboundResults({
    results: messageIds.map((messageId) => ({
      channel: "mattermost",
      messageId,
      channelId: CHANNEL_ID,
    })),
    kind,
    ...(replyToId ? { replyToId } : {}),
  });
}

function setupMattermostTrace(recorder: WireRecorder) {
  const client = createRecordingMattermostClient(recorder);
  const draftStream = createMattermostDraftStream({
    client,
    channelId: CHANNEL_ID,
    rootId: ROOT_ID,
    throttleMs: DRAFT_THROTTLE_MS,
    chunkText: (value) =>
      chunkMarkdownTextWithMode(convertMarkdownTables(value, tableMode), textLimit, chunkMode),
  });
  const previewLifecycle = createLivePreviewLifecycle<ReplyPayload, string>({
    draft: { ...draftStream, id: draftStream.postId },
  });
  let lastPartialText = "";

  const publishedDelivery = (
    parts: ReturnType<typeof draftStream.resolveFinalText>["publishedParts"],
  ) => {
    if (!parts.length) {
      return undefined;
    }
    const receipt = receiptFor(
      parts.map((part) => part.messageId),
      "preview",
      ROOT_ID,
    );
    return {
      outcome: "text" as const,
      messageIds: listMessageReceiptPlatformIds(receipt),
      receipt,
      visibleReplySent: true,
      content: joinMattermostVisibleContent(parts.map((part) => part.content)),
    };
  };
  const resolvePreviewFinalText = (text?: string) => {
    const resolution = draftStream.resolveFinalText(typeof text === "string" ? text : "");
    const confirmedDelivery = publishedDelivery(resolution.publishedParts);
    const deliveryText = resolution.kind === "already-delivered" ? "" : resolution.text;
    const formatted = convertMarkdownTables(deliveryText, tableMode);
    const chunks = chunkMarkdownTextWithMode(formatted, textLimit, chunkMode);
    if (!chunks.length && formatted) {
      chunks.push(formatted);
    }
    const trimmed = chunks.length === 1 ? chunks[0]?.trim() : undefined;
    if (!trimmed) {
      return {
        deliveryText,
        confirmedDelivery,
        alreadyDelivered: resolution.kind === "already-delivered",
      };
    }
    if (
      lastPartialText &&
      lastPartialText.startsWith(trimmed) &&
      trimmed.length < lastPartialText.length
    ) {
      return { deliveryText, confirmedDelivery, alreadyDelivered: false };
    }
    return { editText: trimmed, deliveryText, confirmedDelivery, alreadyDelivered: false };
  };

  const deliverPayload = async (payloadToDeliver: ReplyPayload) => {
    const finalTextResolution =
      !payloadToDeliver.isError && typeof payloadToDeliver.text === "string"
        ? draftStream.resolveFinalText(payloadToDeliver.text)
        : undefined;
    const resolvedPayload = finalTextResolution
      ? {
          ...payloadToDeliver,
          text: finalTextResolution.kind === "already-delivered" ? "" : finalTextResolution.text,
        }
      : payloadToDeliver;
    return await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: resolvedPayload,
      channelId: CHANNEL_ID,
      accountId: ACCOUNT_ID,
      agentId: "agent",
      replyToId: resolveMattermostReplyRootId({
        kind: "channel",
        threadRootId: ROOT_ID,
        replyToId: payloadToDeliver.replyToId,
      }),
      textLimit,
      tableMode,
      sendMessage: async (_to, text, opts) => {
        const post = await createMattermostPost(client, {
          channelId: CHANNEL_ID,
          message: text,
          rootId: opts.replyToId,
        });
        return {
          messageId: post.id,
          channelId: CHANNEL_ID,
          receipt: receiptFor([post.id], "text", opts.replyToId),
          content: post.message ?? text,
        };
      },
    });
  };

  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start":
      case "tool-progress":
      case "cancel":
        // Typing is websocket-only; cancellation closes out on idle.
        break;
      case "partial": {
        const cleaned = step.text.trim();
        if (!cleaned || cleaned === lastPartialText) {
          break;
        }
        if (
          lastPartialText &&
          lastPartialText.startsWith(cleaned) &&
          cleaned.length < lastPartialText.length
        ) {
          break;
        }
        lastPartialText = cleaned;
        draftStream.updateAssistantText(cleaned);
        break;
      }
      case "block-final":
        if (lastPartialText) {
          lastPartialText = "";
          await draftStream.forceNewMessage();
        }
        break;
      case "final":
        // Join boundary work before potentially editing the preview in place.
        await draftStream.settleBoundaries();
        await deliverMattermostReplyWithDraftPreview({
          payload: {
            ...(step.text !== undefined ? { text: step.text } : {}),
            ...(step.mediaUrls ? { mediaUrls: step.mediaUrls } : {}),
            ...(step.isError ? { isError: true } : {}),
          },
          info: { kind: "final" },
          kind: "channel",
          client,
          previewLifecycle,
          effectiveReplyToId: ROOT_ID,
          resolvePreviewFinalText,
          logVerboseMessage: () => {},
          deliverPayload,
        });
        break;
      case "idle":
        await draftStream.stop();
        await previewLifecycle.cleanup();
        break;
      case "wire-fault":
        throw new Error("mattermost trace scenarios do not script wire faults");
    }
  };
}

const MATTERMOST_TRACE_SCENARIOS: readonly DeliveryTraceScenario[] = [
  deliveryTraceScenarios["streaming-happy"],
  deliveryTraceScenarios["final-only"],
  deliveryTraceScenarios["cancel-mid-stream"],
  {
    name: "final-then-error",
    steps: [
      { kind: "reply-start" },
      { kind: "partial", text: "Successful assistant" },
      { kind: "advance", ms: DRAFT_THROTTLE_MS },
      { kind: "final", text: "Successful assistant final" },
      { kind: "final", text: "Tool error warning", isError: true },
      { kind: "idle" },
    ],
  },
];

describe("mattermost delivery trace goldens", () => {
  for (const scenario of MATTERMOST_TRACE_SCENARIOS) {
    it(`records ${scenario.name}`, async () => {
      const events = await runDeliveryTraceScenario({
        scenario,
        setup: setupMattermostTrace,
      });
      expectDeliveryTraceMatchesGolden({
        goldenUrl: new URL(`./__traces__/${scenario.name}.trace.jsonl`, import.meta.url),
        events,
      });
    });
  }
});
