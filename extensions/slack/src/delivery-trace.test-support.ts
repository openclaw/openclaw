import type { WebClient } from "@slack/web-api";
import {
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type TraceEvent,
  type TraceNormalizer,
} from "openclaw/plugin-sdk/channel-contract-testing";
import { expect } from "vitest";
import { markSlackStreamsStopped } from "./streaming.js";

export const SHORT_FINAL_TEXT = "All checks passed. Ship it.";
export const BLOCKS_FINAL_TEXT = "Release 2026.1.0 is ready to ship.";

// Portable presentation actions render as Block Kit with accessible fallback text.
export const BLOCKS_FINAL_PRESENTATION = {
  blocks: [
    {
      type: "buttons",
      buttons: [
        { label: "Approve release", action: { type: "callback", value: "approve-release" } },
        { label: "Release notes", url: "https://docs.openclaw.ai/release" },
      ],
    },
  ],
};

/** Canonicalizes Slack `sec.micro` timestamps to `ts#N` in first-seen order. */
export function createSlackTsNormalizer(): TraceNormalizer {
  const seen = new Map<string, string>();
  const canonicalize = (value: string) =>
    value.replace(/\b\d{10}\.\d{6}\b/g, (ts) => {
      let mapped = seen.get(ts);
      if (!mapped) {
        mapped = `ts#${seen.size + 1}`;
        seen.set(ts, mapped);
      }
      return mapped;
    });
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return canonicalize(value);
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, walk(entry)]),
      );
    }
    return value;
  };
  return (event: TraceEvent) =>
    event.data === undefined ? event : { ...event, data: walk(event.data) };
}

export function collectSlackWireTexts(events: readonly TraceEvent[]): string[] {
  const texts: string[] = [];
  const pushText = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) {
      texts.push(value);
    }
  };
  for (const event of events) {
    if (event.dir !== "out" || !event.data || typeof event.data !== "object") {
      continue;
    }
    const payload = (event.data as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") {
      continue;
    }
    const record = payload as Record<string, unknown>;
    pushText(record.text);
    pushText(record.markdown_text);
    if (Array.isArray(record.chunks)) {
      for (const chunk of record.chunks) {
        if (chunk && typeof chunk === "object") {
          pushText((chunk as { text?: unknown }).text);
        }
      }
    }
  }
  return texts;
}

export function buildSlackDeliveryProofVerdict(params: {
  scenario: string;
  events: readonly TraceEvent[];
  headSha: string;
  expectedProse: string;
}): Record<string, unknown> {
  const wireTexts = collectSlackWireTexts(params.events);
  return {
    kind: "mock-gateway",
    liveSlack: false,
    harness: "extensions/slack/src/delivery-trace.test.ts",
    channel: "slack",
    scenario: params.scenario,
    headSha: params.headSha,
    environment: {
      node: process.version,
      platform: process.platform,
      slackApi: "recording WebClient",
      provider: "scripted agent turn",
      delivery: "real dispatchPreparedSlackMessage + ChatStreamer/draft preview",
    },
    inboundPayloads: params.events
      .filter((event) => event.dir === "in" && (event.kind === "final" || event.kind === "partial"))
      .map((event) => event.data),
    deliveredWireTexts: wireTexts,
    execFailedDelivered: wireTexts.some((text) => text.includes("Exec failed")),
    proseDelivered: wireTexts.some((text) => text.includes(params.expectedProse)),
    outMethods: params.events.filter((event) => event.dir === "out").map((event) => event.kind),
  };
}

/** Exercises the real Slack dispatch and SDK stream lifecycle with recorded wire calls. */
export async function assertSlackSteeringTransportTrace(params: {
  stoppedBySlack: boolean;
  channelId: string;
  inboundTs: string;
  setup: (recorder: {
    recordWireCall: (call: { method: string; result?: unknown }) => void;
  }) => Promise<(step: DeliveryTraceInStep) => Promise<void>>;
  getClient: () => WebClient;
  assertNoRuntimeError: () => void;
}): Promise<void> {
  const { createSlackSystemEventTestHarness } =
    await import("./monitor/events/system-event-test-harness.js");
  const { registerSlackMessageEvents } = await import("./monitor/events/messages.js");
  const ingress = createSlackSystemEventTestHarness({ channelType: "channel" });
  registerSlackMessageEvents({ ctx: ingress.ctx, handleSlackMessage: async () => {} });
  const handleHumanMessage = ingress.getHandler("message");
  if (!handleHumanMessage) {
    throw new Error("expected registered Slack message ingress");
  }
  let firstStreamTs: string | undefined;
  const events = await runDeliveryTraceScenario({
    scenario: {
      name: params.stoppedBySlack ? "top-level-interruption-stop" : "top-level-interruption",
      steps: [
        { kind: "reply-start" },
        { kind: "tool-progress", name: "inspect", phase: "start" },
        { kind: "final", text: "Final below the later human message." },
        { kind: "idle" },
      ],
    },
    setup: async (recorder) => {
      const dispatch = await params.setup({
        recordWireCall: (call) => {
          if (call.method === "chat.startStream" && !firstStreamTs) {
            firstStreamTs = (call.result as { ts?: string })?.ts;
          }
          recorder.recordWireCall(call);
        },
      });
      return async (step) => {
        if (step.kind === "final") {
          expect(firstStreamTs).toBeDefined();
          await handleHumanMessage({
            event: {
              type: "message",
              channel: params.channelId,
              channel_type: "channel",
              user: "U_SECOND",
              text: "Later human message",
              ts: "1767225602.000100",
            },
            body: { api_app_id: "A_TRACE" },
          });
          if (params.stoppedBySlack && firstStreamTs) {
            markSlackStreamsStopped(params.getClient(), params.channelId, [firstStreamTs]);
          }
        }
        await dispatch(step);
      };
    },
  });
  const out = events.filter((event) => event.dir === "out");
  const methods = out.map((event) => event.kind);
  const starts = out.filter((event) => event.kind === "chat.startStream");
  expect(starts[0]?.data).toMatchObject({ payload: { thread_ts: params.inboundTs } });
  expect(methods).not.toContain("chat.postMessage");
  if (params.stoppedBySlack) {
    expect(starts).toHaveLength(1);
    expect(methods).not.toContain("chat.stopStream");
    expect(collectSlackWireTexts(events).join("\n")).not.toContain("Final below");
  } else {
    expect(starts).toHaveLength(2);
    expect(starts[1]?.data).toMatchObject({ payload: { thread_ts: params.inboundTs } });
    expect(methods.indexOf("chat.stopStream")).toBeGreaterThan(methods.indexOf("chat.startStream"));
    expect(methods.indexOf("chat.stopStream")).toBeLessThan(
      methods.lastIndexOf("chat.startStream"),
    );
    expect(collectSlackWireTexts(events).join("\n")).toContain("Final below");
  }
  params.assertNoRuntimeError();
  if (process.env.OPENCLAW_DELIVERY_PROOF === "1") {
    process.stdout.write(
      `${JSON.stringify({ proof: "slack-top-level-steering", headSha: process.env.OPENCLAW_DELIVERY_PROOF_SHA, stoppedBySlack: params.stoppedBySlack, transport: "real dispatch and SDK ChatStreamer; recording WebClient", wireMethods: methods.filter((method) => method.startsWith("chat.")), wireTexts: collectSlackWireTexts(events) })}\n`,
    );
  }
}
