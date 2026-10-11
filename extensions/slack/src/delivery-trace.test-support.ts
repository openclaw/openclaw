import type { WebClient } from "@slack/web-api";
import { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import {
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type TraceEvent,
  type TraceNormalizer,
} from "openclaw/plugin-sdk/channel-contract-testing";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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

export async function assertSlackExpiredProgressTrace(
  params: SlackProgressRecoveryTraceParams,
): Promise<void> {
  const finalText = "The recovered native turn is complete.";
  let finalAcknowledgementChecked = false;
  const events = await runDeliveryTraceScenario({
    scenario: {
      name: "expired-native-progress",
      steps: [
        { kind: "reply-start" },
        { kind: "partial", text: params.narration },
        { kind: "tool-progress", name: "write", phase: "start" },
        { kind: "advance", ms: 2000 },
        { kind: "tool-progress", name: "write", phase: "result" },
        { kind: "final", text: finalText },
        { kind: "idle" },
      ],
    },
    setup: async (recorder) => {
      const dispatch = await params.setup(recorder, "progress-native-unified");
      params.state.rejectAppendStreamCode = "message_not_in_streaming_state";
      const client = params.state.client as unknown as {
        chat: { update: (args: Record<string, unknown>) => Promise<unknown> };
      };
      const update = client.chat.update;
      const entered = createDeferred<void>();
      const response = createDeferred<void>();
      client.chat.update = async (args) => {
        if (JSON.stringify(args.blocks).includes(finalText)) {
          entered.resolve();
          await response.promise;
        }
        return await update(args);
      };
      return async (step) => {
        if (step.kind !== "final") {
          await dispatch(step);
          return;
        }
        const pending = dispatch(step);
        await entered.promise;
        expect(params.state.counts.final).toBe(0);
        finalAcknowledgementChecked = true;
        response.resolve();
        await pending;
        expect(params.state.counts.final).toBe(1);
      };
    },
    normalize: createSlackTsNormalizer(),
  });
  const out = events.filter((event) => event.dir === "out");
  const starts = out.filter((event) => event.kind === "chat.startStream");
  const updates = out.filter((event) => event.kind === "chat.update");
  const streamTs = (starts[0]?.data as { result?: { ts?: string } })?.result?.ts;
  expect(starts).toHaveLength(1);
  expect(updates.length).toBeGreaterThanOrEqual(2);
  expect(updates.every((event) => (event.data as { target?: string }).target === streamTs)).toBe(
    true,
  );
  expect(JSON.stringify(updates.at(-1)?.data)).toContain(finalText);
  expect(JSON.stringify(updates.at(-1)?.data)).toContain('"status":"complete"');
  expect(JSON.stringify(updates.at(-1)?.data)).toContain("src/native-card.ts");
  expect(out.filter((event) => event.kind === "chat.appendStream")).toHaveLength(1);
  expect(
    out.some((event) => event.kind === "chat.postMessage" || event.kind === "chat.stopStream"),
  ).toBe(false);
  expect(finalAcknowledgementChecked).toBe(true);
  params.assertRuntimeErrorCount(0);
}

export async function assertSlackRejectedRecoveryFinalTrace(
  params: SlackProgressRecoveryTraceParams,
  failure: string,
): Promise<void> {
  const acknowledgedPrefix = "The acknowledged answer prefix.";
  const finalText = failure === "oversized" ? "a".repeat(12001) : "The final answer.";
  let rejectedUpdates = 0;
  const events = await runDeliveryTraceScenario({
    scenario: {
      name: "oversized-expired-native-final",
      steps: [
        { kind: "reply-start" },
        { kind: "partial", text: params.narration },
        { kind: "tool-progress", name: "write", phase: "start" },
        { kind: "advance", ms: 2000 },
        { kind: "tool-progress", name: "write", phase: "result" },
        { kind: "final", text: acknowledgedPrefix },
        { kind: "final", text: finalText },
        { kind: "idle" },
      ],
    },
    setup: async (recorder) => {
      const dispatch = await params.setup(recorder, "progress-native-unified");
      params.state.rejectAppendStreamCode = "message_not_in_streaming_state";
      if (failure !== "oversized") {
        const client = params.state.client as unknown as {
          chat: { update: (args: Record<string, unknown>) => Promise<unknown> };
        };
        const update = client.chat.update;
        client.chat.update = async (args) => {
          if (JSON.stringify(args.blocks).includes(finalText)) {
            rejectedUpdates += 1;
            const error = new Error(`An API error occurred: ${failure}`);
            Object.assign(error, { data: { ok: false, error: failure } });
            throw error;
          }
          return await update(args);
        };
      }
      return dispatch;
    },
    normalize: createSlackTsNormalizer(),
  });
  const posted = events.filter((event) => event.kind === "chat.postMessage");
  if (failure === "oversized") {
    expect(posted.length).toBeGreaterThan(1);
  } else {
    expect(posted).toHaveLength(1);
  }
  expect(rejectedUpdates).toBe(failure === "oversized" ? 0 : 1);
  expect(
    events.some(
      (event) =>
        event.kind === "chat.update" && JSON.stringify(event.data).includes(acknowledgedPrefix),
    ),
  ).toBe(true);
  expect(collectSlackWireTexts(posted).join("")).toBe(finalText);
  expect(params.state.counts.final).toBe(2);
  expect(events.some((event) => event.kind === "chat.stopStream")).toBe(false);
  params.assertRuntimeErrorCount(0);
}

export async function assertSlackOrdinaryFallbackCleanupTrace(
  params: SlackProgressRecoveryTraceParams,
  cleanup: string,
): Promise<void> {
  const acknowledgedPrefix = "The acknowledged answer prefix.";
  const finalText = "The fallback answer tail.";
  const postResponseLost = cleanup === "post_response_lost";
  const postError = new Error("socket reset after accepted post");
  const events = await runDeliveryTraceScenario({
    scenario: {
      name: "ordinary-fallback-native-cleanup",
      steps: [
        { kind: "reply-start" },
        { kind: "final", text: acknowledgedPrefix },
        { kind: "final", text: finalText },
        { kind: "idle" },
      ],
    },
    setup: async (recorder) => {
      const dispatch = await params.setup(recorder, "streaming-happy-native");
      params.state.rejectAppendStreamCode = "team_not_found";
      const client = params.state.client as unknown as {
        chat: {
          stopStream: (args: Record<string, unknown>) => Promise<unknown>;
          postMessage: (args: Record<string, unknown>) => Promise<unknown>;
        };
      };
      const stop = client.chat.stopStream;
      let stopAttempts = 0;
      client.chat.stopStream = async (args) => {
        stopAttempts += 1;
        if (stopAttempts > 1 && cleanup === "success") {
          return await stop(args);
        }
        const code =
          stopAttempts === 1
            ? "team_not_found"
            : postResponseLost
              ? "message_not_in_streaming_state"
              : cleanup;
        recorder.recordWireCall({
          method: "chat.stopStream",
          target: asWireString(args.ts),
          payload: stripToken(args),
          result: { ok: false, error: code },
        });
        const error = new Error(`An API error occurred: ${code}`);
        Object.assign(error, { data: { ok: false, error: code } });
        throw error;
      };
      if (postResponseLost) {
        const post = client.chat.postMessage;
        client.chat.postMessage = async (args) => {
          await post(args);
          throw postError;
        };
      }
      return async (step) => {
        if (postResponseLost && step.kind === "idle") {
          await expect(dispatch(step)).rejects.toBe(postError);
        } else {
          await dispatch(step);
        }
      };
    },
    normalize: createSlackTsNormalizer(),
  });
  const chatEvents = events.filter(
    (event) => event.dir === "out" && event.kind.startsWith("chat."),
  );
  expect(chatEvents.map((event) => event.kind)).toEqual([
    "chat.startStream",
    "chat.appendStream",
    "chat.stopStream",
    "chat.postMessage",
    ...(postResponseLost ? [] : ["chat.stopStream"]),
  ]);
  const posted = chatEvents.filter((event) => event.kind === "chat.postMessage");
  expect(posted).toHaveLength(1);
  expect(collectSlackWireTexts(posted)).toEqual([finalText]);
  expect(
    collectSlackWireTexts(chatEvents.filter((event) => event.kind === "chat.startStream")),
  ).toEqual([acknowledgedPrefix]);
  if (!postResponseLost) {
    expect(chatEvents.at(-1)?.data).toMatchObject({ payload: { chunks: [] } });
  }
  expect(params.state.counts.final).toBe(postResponseLost ? 1 : 2);
  params.assertRuntimeErrorCount(cleanup === "internal_error" || postResponseLost ? 1 : 0);
}

export async function assertSlackStoppedProgressTrace(
  params: SlackProgressRecoveryTraceParams,
): Promise<void> {
  let streamTs: string | undefined;
  const events = await runDeliveryTraceScenario({
    scenario: {
      name: "slack-stopped-native-stream",
      steps: [
        { kind: "reply-start" },
        { kind: "partial", text: params.narration },
        { kind: "tool-progress", name: "write", phase: "start" },
        // The progress compositor emits its initial card at 1500ms.
        { kind: "advance", ms: 2000 },
        { kind: "cancel" },
        { kind: "final", text: "Late answer that must not be posted" },
        { kind: "idle" },
      ],
    },
    setup: async (recorder) => {
      const handleStep = await params.setup(
        {
          recordWireCall: (call) => {
            if (call.method === "chat.startStream") {
              streamTs = (call.result as { ts?: string })?.ts;
            }
            recorder.recordWireCall(call);
          },
        },
        "progress-native-unified",
      );
      return async (step) => {
        if (step.kind === "cancel") {
          expect(streamTs).toBeDefined();
          markSlackStreamsStopped(params.state.client as unknown as WebClient, params.channelId, [
            streamTs!,
          ]);
        }
        await handleStep(step);
      };
    },
    normalize: createSlackTsNormalizer(),
  });
  const outMethods = events.filter((event) => event.dir === "out").map((event) => event.kind);
  expect(outMethods).toContain("chat.startStream");
  expect(outMethods).not.toContain("chat.stopStream");
  expect(outMethods).not.toContain("chat.postMessage");
  expect(collectSlackWireTexts(events).join("\n")).not.toContain("Late answer");
  params.assertRuntimeErrorCount(0);
}

type RecordedWireCall = {
  method: string;
  target?: string;
  payload?: unknown;
  result?: unknown;
};

type SlackRecordingTraceState = {
  recordWireCall: (call: RecordedWireCall) => void;
  tsCounter: number;
  rejectStartStreamCode: string | undefined;
  rejectAppendStreamCode: string | undefined;
};

type SlackProgressRecoveryTraceParams = {
  setup: (
    recorder: { recordWireCall: (call: RecordedWireCall) => void },
    scenario: "progress-native-unified" | "streaming-happy-native",
  ) => Promise<(step: DeliveryTraceInStep) => Promise<void>>;
  state: {
    client: Record<string, unknown> | null;
    counts: { final: number };
    rejectAppendStreamCode: string | undefined;
  };
  narration: string;
  channelId: string;
  assertRuntimeErrorCount: (count: number) => void;
};

/** Wire args are untyped records; targets only ever carry string ids. */
function asWireString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Drop credential-bearing fields so tokens can never reach committed goldens. */
function stripToken(args: Record<string, unknown>): Record<string, unknown> {
  const { token: _token, ...rest } = args;
  return rest;
}

export function createRecordingSlackClient(
  state: SlackRecordingTraceState,
  teamId: string,
): Record<string, unknown> {
  const nextSlackTs = () => {
    state.tsCounter += 1;
    return `1767225601.${String(state.tsCounter).padStart(6, "0")}`;
  };
  const record = (call: RecordedWireCall) => {
    state.recordWireCall(call);
  };
  const unexpected = (method: string) => async () => {
    throw new Error(`unexpected Slack wire call: ${method}`);
  };
  const client: Record<string, unknown> = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        const ts = nextSlackTs();
        record({
          method: "chat.postMessage",
          target: asWireString(args.channel),
          payload: stripToken(args),
          result: { ts },
        });
        return {
          ok: true,
          channel: args.channel,
          ts,
          message: { ts, ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}) },
        };
      },
      update: async (args: Record<string, unknown>) => {
        record({
          method: "chat.update",
          target: asWireString(args.ts),
          payload: stripToken(args),
          result: { ok: true },
        });
        return { ok: true, channel: args.channel, ts: args.ts };
      },
      delete: async (args: Record<string, unknown>) => {
        record({
          method: "chat.delete",
          target: asWireString(args.ts),
          payload: stripToken(args),
          result: { ok: true },
        });
        return { ok: true };
      },
      startStream: async (args: Record<string, unknown>) => {
        const rejectCode = state.rejectStartStreamCode;
        if (rejectCode) {
          state.rejectStartStreamCode = undefined;
          record({
            method: "chat.startStream",
            target: asWireString(args.channel),
            payload: stripToken(args),
            result: { ok: false, error: rejectCode },
          });
          const err = new Error(`An API error occurred: ${rejectCode}`);
          (err as Error & { data?: unknown }).data = { ok: false, error: rejectCode };
          throw err;
        }
        const ts = nextSlackTs();
        record({
          method: "chat.startStream",
          target: asWireString(args.channel),
          payload: stripToken(args),
          result: { ts },
        });
        return { ok: true, ts };
      },
      appendStream: async (args: Record<string, unknown>) => {
        const rejectCode = state.rejectAppendStreamCode;
        if (rejectCode) {
          state.rejectAppendStreamCode = undefined;
          record({
            method: "chat.appendStream",
            target: asWireString(args.ts),
            payload: stripToken(args),
            result: { ok: false, error: rejectCode },
          });
          const error = new Error(`An API error occurred: ${rejectCode}`);
          Object.assign(error, { data: { ok: false, error: rejectCode } });
          throw error;
        }
        record({
          method: "chat.appendStream",
          target: asWireString(args.ts),
          payload: stripToken(args),
          result: { ok: true },
        });
        return { ok: true, ts: args.ts };
      },
      stopStream: async (args: Record<string, unknown>) => {
        record({
          method: "chat.stopStream",
          target: asWireString(args.ts),
          payload: stripToken(args),
          result: { ok: true },
        });
        return { ok: true, ts: args.ts };
      },
    },
    users: {
      info: async (args: Record<string, unknown>) => {
        record({
          method: "users.info",
          target: asWireString(args.user),
          payload: stripToken(args),
          result: { team_id: teamId },
        });
        return { ok: true, user: { team_id: teamId } };
      },
    },
    apiCall: async (method: string, args: Record<string, unknown>) => {
      record({
        method,
        target: `${asWireString(args.channel_id)}/${asWireString(args.thread_ts)}`,
        payload: stripToken(args),
        result: { ok: true },
      });
      return { ok: true };
    },
    conversations: { open: unexpected("conversations.open") },
    reactions: Object.fromEntries(
      ["add", "remove"].map((action) => [
        action,
        async (args: Record<string, unknown>) => {
          record({ method: `reactions.${action}`, payload: stripToken(args) });
          return { ok: true };
        },
      ]),
    ),
  };
  // Mirror WebClient.chatStream: the REAL SDK ChatStreamer runs against this
  // recording client, so its local buffering decides when wire calls happen.
  client.chatStream = (args: unknown) =>
    new ChatStreamer(client as never, { debug: () => {} } as never, args as never, {});
  return client;
}
