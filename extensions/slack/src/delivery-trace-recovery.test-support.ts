import {
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
} from "openclaw/plugin-sdk/channel-contract-testing";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect } from "vitest";
import { collectSlackWireTexts, createSlackTsNormalizer } from "./delivery-trace.test-support.js";

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

type RecordedWireCall = {
  method: string;
  target?: string;
  payload?: unknown;
  result?: unknown;
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
