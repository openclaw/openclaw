// Real monitor/dispatcher lifecycle with a recording plain-room client.
// Goldens preserve edit IDs, mention-inert previews, and final/redaction ordering.
import { MatrixEvent, type IEvent } from "matrix-js-sdk/lib/matrix.js";
import {
  deliveryTraceScenarios,
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceScenario,
  type WireRecorder,
} from "openclaw/plugin-sdk/channel-contract-testing";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-mention-gating";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { beforeAll, describe, it, vi } from "vitest";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./matrix/monitor/handler.test-helpers.js";
import type { MatrixClient } from "./matrix/sdk.js";
import { installMatrixTestRuntime } from "./test-runtime.js";

const ROOM_ID = "!room:example.org";
const BOT_USER_ID = "@openclaw:example.org";
const INBOUND_EVENT_ID = "$inbound-1";

beforeAll(() => {
  // Real text/mention helpers keep rendered wire content in the lifecycle proof.
  installMatrixTestRuntime({
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: createPluginRuntimeMock().channel.inbound,
      text: {
        resolveMarkdownTableMode,
        convertMarkdownTables,
        resolveTextChunkLimit,
        resolveChunkMode,
        chunkMarkdownTextWithMode,
      },
      mentions: {
        buildMentionRegexes: () => [],
        matchesMentionPatterns: (text: string, patterns: RegExp[]) =>
          patterns.some((pattern) => pattern.test(text)),
        matchesMentionWithExplicit: () => false,
        implicitMentionKindWhen,
        resolveInboundMentionDecision,
      },
    } as unknown as PluginRuntime["channel"],
  });
});

function createRecordingMatrixClient(recorder: WireRecorder): Partial<MatrixClient> {
  // Every event, including edits and redactions, consumes a deterministic ID.
  const eventsById = new Map<string, IEvent>();
  let eventCount = 0;
  const mintEventId = () => `$e${++eventCount}`;
  return {
    getUserId: async () => BOT_USER_ID,
    prepareRoomForMessageSend: async () => "m.room.message",
    sendMessage: async (roomId: string, content: Record<string, unknown>) => {
      const eventId = mintEventId();
      // Edits reuse content structures; the recorder serializes at compare time.
      const payload = structuredClone(content);
      eventsById.set(eventId, {
        event_id: eventId,
        sender: BOT_USER_ID,
        type: "m.room.message",
        origin_server_ts: Date.now(),
        content: payload,
      });
      recorder.recordWireCall({
        method: "sendMessage",
        target: roomId,
        payload,
        result: { event_id: eventId },
      });
      return eventId;
    },
    getEvent: async (_roomId: string, eventId: string) => {
      recorder.recordWireCall({
        method: "getEvent",
        target: eventId,
        result: { found: eventsById.has(eventId) },
      });
      const event = eventsById.get(eventId);
      if (!event) {
        throw new Error(`Unknown recorded Matrix event: ${eventId}`);
      }
      return structuredClone(event);
    },
    getRelations: async (_roomId, eventId, relationType, eventType, opts) => {
      const originalEvent = eventsById.get(eventId);
      const events = [...eventsById.values()].filter((event) => {
        const relation = new MatrixEvent(event).getRelation();
        return (
          relation?.event_id === eventId &&
          relation.rel_type === relationType &&
          (!eventType || event.type === eventType) &&
          (relationType !== "m.replace" || event.sender === originalEvent?.sender)
        );
      });
      recorder.recordWireCall({
        method: "getRelations",
        target: eventId,
        payload: { relationType, eventType: eventType ?? null, limit: opts?.limit },
        result: { count: events.length },
      });
      return { originalEvent: originalEvent ?? null, events, nextBatch: null, prevBatch: null };
    },
    redactEvent: async (_roomId: string, eventId: string) => {
      const redactionEventId = mintEventId();
      recorder.recordWireCall({
        method: "redactEvent",
        target: eventId,
        result: { event_id: redactionEventId },
      });
      return redactionEventId;
    },
    setTyping: async (roomId: string, typing: boolean, timeoutMs: number) => {
      recorder.recordWireCall({
        method: "setTyping",
        target: roomId,
        payload: { typing, timeoutMs },
      });
    },
    sendReadReceipt: async (_roomId: string, eventId: string) => {
      recorder.recordWireCall({ method: "sendReadReceipt", target: eventId });
    },
  };
}

type MatrixTraceDeliver = (payload: ReplyPayload, info: { kind: string }) => Promise<void>;

type MatrixTraceReplyOptions = {
  onPartialReply?: (payload: { text: string }) => void;
  onBlockReplyQueued?: (
    payload: { text?: string },
    context?: { assistantMessageIndex?: number },
  ) => Promise<void> | void;
  onAssistantMessageStart?: () => void;
};

async function setupMatrixTrace(recorder: WireRecorder) {
  let capturedDeliver: MatrixTraceDeliver | undefined;
  let capturedOnReplyStart: (() => Promise<void> | void) | undefined;
  let capturedOnIdle: (() => void) | undefined;
  let capturedReplyOptions: MatrixTraceReplyOptions | undefined;
  const { promise: captured, resolve: resolveCaptured } = Promise.withResolvers<void>();

  // Hold dispatch until final/cancel so the handler owns draft cleanup ordering.
  const { promise: runGate, resolve: releaseRun } = Promise.withResolvers<boolean>();

  const { handler } = createMatrixHandlerTestHarness({
    streaming: "partial",
    blockStreamingEnabled: true,
    client: createRecordingMatrixClient(recorder),
    resolveMarkdownTableMode: () => resolveMarkdownTableMode({ cfg: {}, channel: "matrix" }),
    createReplyDispatcherWithTyping: (options: Record<string, unknown> | undefined) => {
      capturedDeliver = options?.deliver as MatrixTraceDeliver | undefined;
      capturedOnReplyStart = options?.onReplyStart as typeof capturedOnReplyStart;
      capturedOnIdle = options?.onIdle as typeof capturedOnIdle;
      return {
        dispatcher: { markComplete: () => {}, waitForIdle: async () => {} },
        replyOptions: {},
        markDispatchIdle: () => {},
        markRunComplete: () => {},
      };
    },
    dispatchInboundMessage: (async (args: { replyOptions?: MatrixTraceReplyOptions }) => {
      capturedReplyOptions = args?.replyOptions;
      resolveCaptured();
      const queuedFinal = await runGate;
      return { queuedFinal, counts: { final: queuedFinal ? 1 : 0, block: 0, tool: 0 } };
    }) as never,
  });

  const handlerDone = handler(
    ROOM_ID,
    createMatrixTextMessageEvent({
      eventId: INBOUND_EVENT_ID,
      body: "deploy status?",
      originServerTs: Date.now(),
    }),
  );
  await Promise.race([
    captured,
    handlerDone.then(() => {
      throw new Error("matrix handler settled before capturing dispatcher wiring");
    }),
  ]);
  // Drain the fire-and-forget read receipt before the first scripted step.
  await vi.advanceTimersByTimeAsync(0);

  // Tool rounds start a new assistant generation and reset cumulative offsets.
  let assistantMessageIndex = 0;
  const startAssistantMessage = () => {
    assistantMessageIndex += 1;
    capturedReplyOptions?.onAssistantMessageStart?.();
  };

  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start":
        await capturedOnReplyStart?.();
        startAssistantMessage();
        break;
      case "partial":
        capturedReplyOptions?.onPartialReply?.({ text: step.text });
        break;
      case "block-final":
        await capturedReplyOptions?.onBlockReplyQueued?.(
          { text: step.text },
          { assistantMessageIndex },
        );
        await capturedDeliver?.({ text: step.text }, { kind: "block" });
        break;
      case "tool-progress":
        if (step.phase === "result") {
          startAssistantMessage();
        }
        break;
      case "final":
        await capturedDeliver?.({ text: step.text }, { kind: "final" });
        releaseRun(true);
        await handlerDone;
        break;
      case "cancel":
        releaseRun(false);
        await handlerDone;
        break;
      case "idle":
        capturedOnIdle?.();
        break;
      case "wire-fault":
        throw new Error("matrix trace scenarios do not script wire faults");
    }
  };
}

const GEN_ONE_BLOCK = "Build check: all suites green.";
const GEN_TWO_PREVIEW = "Deploying to production now. Watching health checks.";
const GEN_TWO_FINAL = "Deploying to production now. Health checks green.";

// Cross the 1000ms edit throttle once per generation.
function previewSteps(first: string, last: string): DeliveryTraceInStep[] {
  return [
    { kind: "partial", text: first },
    { kind: "advance", ms: 400 },
    { kind: "partial", text: last },
    { kind: "advance", ms: 700 },
  ];
}

function finalScenario(name: string, first: string, last: string): DeliveryTraceScenario {
  return {
    name,
    steps: [
      { kind: "reply-start" },
      ...previewSteps(first, last),
      { kind: "final", text: last },
      { kind: "idle" },
    ],
  };
}

const MATRIX_TRACE_SCENARIOS: readonly DeliveryTraceScenario[] = [
  // First generation finalizes in place; second replaces a differing preview.
  {
    name: "streaming-happy-multi-generation",
    steps: [
      { kind: "reply-start" },
      ...previewSteps("Build check:", GEN_ONE_BLOCK),
      { kind: "block-final", text: GEN_ONE_BLOCK },
      { kind: "tool-progress", name: "deploy", phase: "start" },
      { kind: "tool-progress", name: "deploy", phase: "result" },
      ...previewSteps("Deploying to production now.", GEN_TWO_PREVIEW),
      { kind: "final", text: GEN_TWO_FINAL },
      { kind: "idle" },
    ],
  },
  // Clear only the live marker when final text equals the preview.
  finalScenario(
    "final-in-place",
    "Ship checklist complete.",
    "Ship checklist complete. Tagging the release.",
  ),
  // Mention-bearing finals must be sent fresh before redacting the quiet preview.
  finalScenario(
    "final-mentions-fresh",
    "Paging @oncall:example.org",
    "Paging @oncall:example.org for the deploy review.",
  ),
  deliveryTraceScenarios["cancel-mid-stream"],
];

describe("matrix delivery trace goldens", () => {
  for (const scenario of MATRIX_TRACE_SCENARIOS) {
    it(`records ${scenario.name}`, async () => {
      expectDeliveryTraceMatchesGolden({
        goldenUrl: new URL(`./__traces__/${scenario.name}.trace.jsonl`, import.meta.url),
        events: await runDeliveryTraceScenario({ scenario, setup: setupMatrixTrace }),
      });
    });
  }
});
