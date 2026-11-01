// Real dispatcher/stream-controller wiring, recorded at the Bot Framework boundary.
import {
  deliveryTraceScenarios,
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceScenarioName,
  type WireRecorder,
} from "openclaw/plugin-sdk/channel-contract-testing";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { chunkMarkdownTextWithMode, resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { it } from "vitest";
import { createMSTeamsReplyDispatcher } from "./reply-dispatcher.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

function createRecordingStream(recorder: WireRecorder, faultAtWrite?: number) {
  let writes = 0;
  let canceled = false;
  const applyFault = (method: string, payload?: unknown): boolean => {
    writes += 1;
    if (faultAtWrite === undefined || writes < faultAtWrite) {
      return false;
    }
    // HttpStream observes the rejected POST asynchronously, not inside emit/update.
    queueMicrotask(() => {
      canceled = true;
    });
    recorder.recordWireCall({
      method,
      ...(payload !== undefined ? { payload } : {}),
      result: { error: "StreamCancelledError" },
    });
    return true;
  };
  const write = (method: string, payload: unknown) => {
    if (!applyFault(method, payload)) {
      recorder.recordWireCall({ method, payload });
    }
  };
  return {
    emit(activity: unknown): void {
      write("stream.emit", typeof activity === "string" ? { text: activity } : activity);
    },
    update(text: string): void {
      write("stream.update", { text });
    },
    clearText(): void {},
    async close(): Promise<unknown> {
      if (applyFault("stream.close")) {
        throw Object.assign(new Error("stream cancelled by user Stop"), {
          name: "StreamCancelledError",
        });
      }
      recorder.recordWireCall({ method: "stream.close", result: { id: "stream-final" } });
      return { id: "stream-final" };
    },
    get canceled(): boolean {
      return canceled;
    },
  };
}

type MSTeamsTraceCase = {
  golden: string;
  scenario: DeliveryTraceScenarioName;
  conversationType: "personal" | "channel";
  conversationId: string;
  faultAtWrite?: number;
};

const MSTEAMS_TRACE_CASES: readonly MSTeamsTraceCase[] = [
  {
    golden: "streaming-happy-dm",
    scenario: "streaming-happy",
    conversationType: "personal",
    conversationId: "a:1dm-trace-conversation",
  },
  {
    golden: "block-fallback-channel",
    scenario: "streaming-happy",
    conversationType: "channel",
    conversationId: "19:channel-trace@thread.tacv2;messageid=1000",
  },
  {
    golden: "cancel-via-write-error",
    scenario: "cancel-mid-stream",
    conversationType: "personal",
    conversationId: "a:1dm-trace-conversation",
    faultAtWrite: 2,
  },
];

function setupMSTeamsTrace(recorder: WireRecorder, traceCase: MSTeamsTraceCase) {
  setMSTeamsRuntime({
    channel: {
      text: {
        resolveChunkMode,
        chunkMarkdownTextWithMode,
        convertMarkdownTables,
        resolveMarkdownTableMode,
      },
    },
    system: {
      enqueueSystemEvent: (text: string, opts?: { contextKey?: string }) => {
        recorder.recordWireCall({
          method: "system.enqueueSystemEvent",
          payload: { text, contextKey: opts?.contextKey },
        });
      },
    },
  } as unknown as PluginRuntime);
  const stream = createRecordingStream(recorder, traceCase.faultAtWrite);
  const { conversationId, conversationType } = traceCase;
  let activityCount = 0;
  const reject = (method: string) => async () => {
    throw new Error(`unexpected turn-context call: ${method}`);
  };
  const context: MSTeamsTurnContext = {
    activity: { type: "message", conversation: { id: conversationId, conversationType } },
    sendActivity: async (activity) => {
      const id = `activity-${++activityCount}`;
      recorder.recordWireCall({
        method: "context.sendActivity",
        target: conversationId,
        payload: typeof activity === "string" ? { text: activity } : activity,
        result: { id },
      });
      return { id };
    },
    updateActivity: reject("updateActivity"),
    stream,
  };
  const { replyOptions, dispatcherOptions, delivery } = createMSTeamsReplyDispatcher({
    cfg: { channels: { msteams: {} } },
    agentId: "agent",
    sessionKey: "agent:msteams:trace",
    log: { info: () => {}, error: () => {} },
    app: {} as never,
    conversationRef: {
      activityId: "inbound-activity",
      user: { id: "29:trace-user", name: "Trace User" },
      agent: { id: "28:trace-bot", name: "OpenClaw" },
      conversation: {
        id: traceCase.conversationId,
        conversationType: traceCase.conversationType,
        tenantId: "tenant-trace",
      },
      tenantId: "tenant-trace",
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
    },
    context,
    replyStyle: "thread",
    textLimit: 4000,
  });
  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start":
        await dispatcherOptions.onReplyStart?.();
        break;
      case "partial":
        replyOptions.onPartialReply?.({ text: step.text });
        break;
      case "block-final":
        await delivery.deliver({ text: step.text }, { kind: "block" });
        break;
      case "tool-progress":
        await replyOptions.onToolStart?.({ name: step.name, phase: step.phase });
        break;
      case "final":
        await delivery.deliver(
          {
            ...(step.text !== undefined ? { text: step.text } : {}),
            ...(step.mediaUrls ? { mediaUrls: step.mediaUrls } : {}),
            ...(step.isError ? { isError: true } : {}),
          },
          { kind: "final" },
        );
        break;
      case "cancel":
        // User Stop is observed asynchronously through the armed write fault.
        break;
      case "idle":
        await dispatcherOptions.onSettled?.();
        break;
      case "wire-fault":
        throw new Error("msteams trace scenarios arm stream write faults at setup instead");
    }
  };
}

for (const traceCase of MSTEAMS_TRACE_CASES) {
  it(`records ${traceCase.golden}`, async () => {
    const events = await runDeliveryTraceScenario({
      scenario: deliveryTraceScenarios[traceCase.scenario],
      setup: (recorder) => setupMSTeamsTrace(recorder, traceCase),
    });
    expectDeliveryTraceMatchesGolden({
      goldenUrl: new URL(`./__traces__/${traceCase.golden}.trace.jsonl`, import.meta.url),
      events,
    });
  });
}
