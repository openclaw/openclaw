import type { WebClient } from "@slack/web-api";
// Slack delivery trace goldens: replayable wire-level lifecycle recordings.
//
// Drives the real dispatch wiring (dispatchPreparedSlackMessage → deliverSlackPayload
// → native stream / draft preview / preview finalize / deliverReplies → sendMessageSlack)
// with the core agent turn mocked at the channel-inbound dispatch seam:
// the scripted steps stand in for the reply dispatcher callbacks (typing, partials,
// tool progress, per-payload deliver). OUT events are the Slack Web API calls observed
// at a recording WebClient stand-in. Native streaming runs through the REAL
// @slack/web-api ChatStreamer so the SDK's buffering contract is captured as-is:
// previews may remain buffered below 256 chars, but finals flush before delivery
// settles, including when native rejection requires ordinary-message fallback.
// Refresh goldens with OPENCLAW_TRACE_UPDATE=1 (see delivery-trace harness docs).
import { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceStep,
} from "openclaw/plugin-sdk/channel-contract-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mergeSlackAccountConfig } from "./accounts.js";
import {
  BLOCKS_FINAL_PRESENTATION,
  BLOCKS_FINAL_TEXT,
  SHORT_FINAL_TEXT,
  assertSlackSteeringTransportTrace,
  buildSlackDeliveryProofVerdict,
  collectSlackWireTexts,
  createSlackTsNormalizer,
} from "./delivery-trace.test-support.js";
import { noteSlackDraftConversationMessage } from "./draft-message-boundaries.js";
import type { PreparedSlackMessage } from "./monitor/message-handler/types.js";
import { setSlackSessionStatus } from "./session-status.js";
import { markSlackStreamsStopped } from "./streaming.js";

type RecordedWireCall = {
  method: string;
  target?: string;
  payload?: unknown;
  result?: unknown;
};

type CapturedDispatcherOptions = {
  deliver: (payload: ReplyPayload, info: { kind: ReplyDispatchKind }) => Promise<unknown>;
  onError?: (err: unknown, info: { kind: string }) => Promise<void> | void;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
  typingCallbacks?: {
    onReplyStart?: () => Promise<void>;
    onIdle?: () => void;
    onCleanup?: () => void;
  };
};

type CapturedReplyOptions = {
  commentaryProgressEnabled?: boolean;
  commentaryPayloadsEnabled?: boolean;
  suppressDefaultToolProgressMessages?: boolean;
  onPartialReply?: (payload: { text: string }) => Promise<void> | void;
  onToolStart?: (payload: {
    name: string;
    phase: "start" | "result";
    itemId?: string;
    toolCallId?: string;
    args?: Record<string, unknown>;
  }) => Promise<void> | void;
  onItemEvent?: (payload: {
    kind: string;
    itemId?: string;
    toolCallId?: string;
    phase?: string;
    status?: string;
    progressText?: string;
    name?: string;
  }) => Promise<void> | void;
};

type TurnCounts = Record<ReplyDispatchKind, number>;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

type SlackTraceState = {
  recordWireCall: (call: RecordedWireCall) => void;
  client: Record<string, unknown> | null;
  turn: { options: CapturedDispatcherOptions; replyOptions: CapturedReplyOptions } | null;
  turnStarted: Deferred<void> | null;
  turnOutcome: Deferred<{ queuedFinal: boolean; counts: TurnCounts }> | null;
  dispatchDone: Promise<void> | null;
  counts: TurnCounts;
  tsCounter: number;
  /** Scripted benign rejection for the next chat.startStream call (scenario-owned). */
  rejectStartStreamCode: string | undefined;
};

const traceRuntimeError = vi.fn();

const traceState = vi.hoisted((): SlackTraceState => ({
  recordWireCall: () => {},
  client: null,
  turn: null,
  turnStarted: null,
  turnOutcome: null,
  dispatchDone: null,
  counts: { tool: 0, block: 0, final: 0 },
  tsCounter: 0,
  rejectStartStreamCode: undefined,
}));

// Replace only the core agent turn. Everything downstream of the captured
// deliver/typing/replyOptions wiring (dedupe, thread plan, native stream ladder,
// draft preview, preview finalize, deliverReplies chunking, sendMessageSlack)
// stays the real production code.
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  type DispatchParams = Parameters<typeof actual.dispatchChannelInboundTurn>[0];
  return {
    ...actual,
    dispatchChannelInboundTurn: async (params: DispatchParams) => {
      traceState.turn = {
        options: {
          ...params.dispatcherOptions,
          deliver: params.delivery.deliver,
          onError: params.delivery.onError,
        } as CapturedDispatcherOptions,
        replyOptions: (params.replyOptions ?? {}) as CapturedReplyOptions,
      };
      traceState.turnStarted?.resolve();
      if (!traceState.turnOutcome) {
        throw new Error("trace turn outcome gate not initialized");
      }
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: params.ctxPayload,
        routeSessionKey: params.route.sessionKey,
        dispatchResult: await traceState.turnOutcome.promise,
      };
    },
  };
});

// send.ts/actions.ts build their own WebClient from tokens; route every client
// resolution to the scenario's recording client so all wire calls are captured.
vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  const traceClient = () => {
    if (!traceState.client) {
      throw new Error("trace Slack client not initialized");
    }
    return traceState.client as never;
  };
  return {
    ...actual,
    createSlackReadClient: traceClient,
    createSlackWebClient: traceClient,
    createSlackWriteClient: traceClient,
    getSlackWriteClient: traceClient,
    getSlackListenerWriteClient: traceClient,
  };
});

import { dispatchPreparedSlackMessage } from "./monitor/message-handler/dispatch.js";

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/channel-inbound");
  vi.doUnmock("./client.js");
  vi.resetModules();
});

afterEach(async () => {
  // Unblock a failed run's pending turn so its dispatch promise settles instead
  // of leaking a forever-pending await into later tests.
  traceState.turnOutcome?.resolve({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
  await traceState.dispatchDone?.catch(() => {});
  traceState.client = null;
  traceState.turn = null;
  traceState.turnStarted = null;
  traceState.turnOutcome = null;
  traceState.dispatchDone = null;
  traceState.rejectStartStreamCode = undefined;
});

const CHANNEL_ID = "C0TRACE";
const USER_ID = "U0TRACE";
const TEAM_ID = "T0TRACE";
// Matches the harness epoch (2026-01-01T00:00:00Z → 1767225600) so the inbound
// ts is plausible under the fake clock; the normalizer canonicalizes it anyway.
const INBOUND_TS = "1767225600.000100";

type SlackTraceScenarioName =
  | "streaming-happy-native"
  | "short-final-native-rejection"
  | "final-blocks-and-text"
  | "cancel-mid-stream"
  | "progress-compact-commentary"
  | "progress-session-card"
  | "progress-native-unified"
  | "native-prose-then-exec-failed"
  | "preview-exec-failed-then-prose";

const NATIVE_SCENARIOS = new Set<SlackTraceScenarioName>([
  "streaming-happy-native",
  "short-final-native-rejection",
  "final-blocks-and-text",
  "native-prose-then-exec-failed",
]);

const NATIVE_PROGRESS_NARRATION =
  "I’m checking the native Slack stream before applying the focused patch.";
const NATIVE_PROGRESS_NARRATION_UPDATED = `${NATIVE_PROGRESS_NARRATION} I’m applying it now.`;

const EXEC_FAILED_TRACE = "⚠️ 🛠️ Exec failed: ";
const EXEC_FAILED_PROSE = "The directory is missing.";
const COMPACT_COMMENTARY_TEXT = "Checking the current Slack behavior.";
const COMPACT_COMMENTARY_TEXT_UPDATED =
  "Checking the current Slack behavior and preparing the focused fix.";
const COMPACT_FINAL_TEXT = "Compact Slack progress is ready.";

// Slack-specific scenario scripts; the runner only consumes `steps` and the
// name (outside the shared scenario library) keys the golden filename.
const slackTraceScenarios: Record<
  Exclude<SlackTraceScenarioName, "streaming-happy-native">,
  readonly DeliveryTraceStep[]
> = {
  "short-final-native-rejection": [
    { kind: "reply-start" },
    { kind: "partial", text: "All checks passed." },
    { kind: "advance", ms: 300 },
    { kind: "final", text: SHORT_FINAL_TEXT },
    { kind: "idle" },
  ],
  "final-blocks-and-text": [
    { kind: "reply-start" },
    { kind: "final", text: BLOCKS_FINAL_TEXT },
    { kind: "idle" },
  ],
  "cancel-mid-stream": [
    { kind: "reply-start" },
    { kind: "partial", text: "Working on the fix" },
    { kind: "advance", ms: 300 },
    { kind: "partial", text: "Working on the fix: patching now." },
    // Past the draft throttle (1000ms) so the second preview edit lands
    // before the run is aborted.
    { kind: "advance", ms: 1100 },
    { kind: "cancel" },
    { kind: "idle" },
  ],
  "progress-compact-commentary": [
    { kind: "reply-start" },
    { kind: "partial", text: COMPACT_COMMENTARY_TEXT },
    { kind: "advance", ms: 2000 },
    { kind: "tool-progress", name: "read", phase: "start" },
    { kind: "partial", text: COMPACT_COMMENTARY_TEXT_UPDATED },
    { kind: "advance", ms: 2000 },
    { kind: "final", text: COMPACT_FINAL_TEXT },
    { kind: "idle" },
  ],
  "progress-session-card": [
    { kind: "reply-start" },
    { kind: "tool-progress", name: "read", phase: "start" },
    { kind: "advance", ms: 2000 },
    { kind: "tool-progress", name: "read", phase: "result" },
    { kind: "final", text: "The session card is complete." },
    { kind: "idle" },
  ],
  "progress-native-unified": [
    { kind: "reply-start" },
    { kind: "partial", text: NATIVE_PROGRESS_NARRATION },
    { kind: "tool-progress", name: "write", phase: "start" },
    { kind: "advance", ms: 2000 },
    { kind: "partial", text: NATIVE_PROGRESS_NARRATION_UPDATED },
    { kind: "tool-progress", name: "write", phase: "result" },
    { kind: "final", text: "The unified native Slack turn is complete." },
    { kind: "idle" },
  ],
  "native-prose-then-exec-failed": [
    { kind: "reply-start" },
    { kind: "final", text: EXEC_FAILED_PROSE },
    { kind: "final", text: EXEC_FAILED_TRACE },
    { kind: "idle" },
  ],
  "preview-exec-failed-then-prose": [
    { kind: "reply-start" },
    { kind: "partial", text: EXEC_FAILED_TRACE },
    { kind: "advance", ms: 1100 },
    { kind: "partial", text: EXEC_FAILED_PROSE },
    { kind: "advance", ms: 1100 },
    { kind: "final", text: EXEC_FAILED_PROSE },
    { kind: "idle" },
  ],
};

function nextSlackTs(): string {
  traceState.tsCounter += 1;
  return `1767225601.${String(traceState.tsCounter).padStart(6, "0")}`;
}

/** Wire args are untyped records; targets only ever carry string ids. */
function asWireString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Drop credential-bearing fields so tokens can never reach committed goldens. */
function stripToken(args: Record<string, unknown>): Record<string, unknown> {
  const { token: _token, ...rest } = args;
  return rest;
}

function createRecordingSlackClient(): Record<string, unknown> {
  const record = (call: RecordedWireCall) => {
    traceState.recordWireCall(call);
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
        const rejectCode = traceState.rejectStartStreamCode;
        if (rejectCode) {
          traceState.rejectStartStreamCode = undefined;
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
          result: { team_id: TEAM_ID },
        });
        return { ok: true, user: { team_id: TEAM_ID } };
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

function createPreparedTraceMessage(scenario: SlackTraceScenarioName): PreparedSlackMessage {
  const compactProgress = scenario === "progress-compact-commentary";
  const progressCard = scenario === "progress-session-card";
  const nativeProgress = scenario === "progress-native-unified";
  const cfg = {
    channels: { slack: { enabled: true } },
    ...(progressCard || nativeProgress
      ? {
          gateway: {
            publicOrigin: "https://team.openclaw.ai",
            controlUi: { basePath: "/openclaw" },
          },
        }
      : {}),
  } as OpenClawConfig;
  const client = traceState.client;
  if (!client) {
    throw new Error("trace Slack client not initialized");
  }
  const prepared = {
    ctx: {
      cfg,
      runtime: { log: () => {}, error: traceRuntimeError },
      botToken: "xoxb-trace",
      app: { client },
      teamId: TEAM_ID,
      botUserId: "UBOT",
      botId: "BBOT",
      textLimit: 4000,
      typingReaction: "",
      allowFrom: [],
      setSlackSessionStatus: ((p) =>
        setSlackSessionStatus({ ...p, client: client as unknown as WebClient }).then(
          ({ ok }) => ok,
        )) satisfies PreparedSlackMessage["ctx"]["setSlackSessionStatus"],
    },
    account: {
      accountId: "default",
      config: compactProgress
        ? {
            streaming: {
              mode: "progress",
              nativeTransport: true,
              progress: {
                style: "compact",
                nativeTaskCards: true,
                label: false,
                commentary: true,
                toolProgress: false,
              },
            },
          }
        : progressCard
          ? // Native task cards are the progress default; this scenario owns the
            // Block Kit opt-out path.
            { streaming: { progress: { nativeTaskCards: false, toolProgress: true } } }
          : nativeProgress
            ? // Exercise the opt-in native tool log.
              { streaming: { mode: "progress", progress: { toolProgress: true } } }
            : {
                streaming: {
                  mode: "partial",
                  nativeTransport: NATIVE_SCENARIOS.has(scenario),
                },
              },
    },
    message: {
      type: "message",
      channel: CHANNEL_ID,
      channel_type: "channel",
      user: USER_ID,
      ts: INBOUND_TS,
      event_ts: INBOUND_TS,
      text: "trace inbound",
    },
    route: {
      agentId: "trace-agent",
      accountId: "default",
      sessionKey: "slack:channel:c0trace",
      mainSessionKey: "main",
      lastRoutePolicy: "session",
    },
    channelConfig: null,
    replyTarget: `channel:${CHANNEL_ID}`,
    ctxPayload: { SessionKey: "slack:channel:c0trace", ChatType: "channel" },
    turn: { record: {} },
    replyToMode: "all",
    isDirectMessage: false,
    isRoomish: true,
    ackReactionValue: "eyes",
    ackReactionPromise: null,
  };
  return prepared as unknown as PreparedSlackMessage;
}

async function setupSlackTrace(
  recorder: { recordWireCall: (call: RecordedWireCall) => void },
  scenario: SlackTraceScenarioName,
  configure?: (prepared: PreparedSlackMessage) => void,
) {
  traceState.recordWireCall = recorder.recordWireCall;
  traceState.tsCounter = 0;
  traceRuntimeError.mockClear();
  traceState.counts = { tool: 0, block: 0, final: 0 };
  traceState.turn = null;
  traceState.turnStarted = createDeferred<void>();
  traceState.turnOutcome = createDeferred<{ queuedFinal: boolean; counts: TurnCounts }>();
  // Rejected native final delivery must complete ordinary-message fallback
  // before the dispatcher settles the final payload.
  traceState.rejectStartStreamCode =
    scenario === "short-final-native-rejection"
      ? "method_not_supported_for_channel_type"
      : undefined;
  traceState.client = createRecordingSlackClient();

  const prepared = createPreparedTraceMessage(scenario);
  configure?.(prepared);
  const dispatchDone = dispatchPreparedSlackMessage(prepared);
  traceState.dispatchDone = dispatchDone;
  await traceState.turnStarted.promise;
  const turn = traceState.turn as SlackTraceState["turn"];
  if (!turn) {
    throw new Error("trace turn wiring was not captured");
  }

  const deliver = async (payload: ReplyPayload, kind: ReplyDispatchKind) => {
    const transformed = turn.options.transformReplyPayload
      ? turn.options.transformReplyPayload(payload)
      : payload;
    if (!transformed) {
      return;
    }
    try {
      await turn.options.deliver(transformed, { kind });
      traceState.counts[kind] += 1;
    } catch (err) {
      // Mirrors the reply dispatcher: failed deliveries report onError and are
      // not counted as dispatched.
      await turn.options.onError?.(err, { kind });
    }
  };

  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start":
        await turn.options.typingCallbacks?.onReplyStart?.();
        break;
      case "partial":
        // Present only on the draft-preview tier; native streaming leaves
        // onPartialReply undefined and partials stay IN-only script context.
        if (scenario === "progress-compact-commentary") {
          await turn.replyOptions.onItemEvent?.({
            kind: "preamble",
            itemId: "preamble-1",
            progressText: step.text,
          });
        } else if (scenario === "progress-native-unified") {
          await turn.replyOptions.onItemEvent?.({
            kind: "preamble",
            itemId: "preamble-1",
            progressText: step.text,
          });
          await deliver({ text: step.text, isCommentary: true }, "block");
        } else {
          await turn.replyOptions.onPartialReply?.({ text: step.text });
        }
        break;
      case "tool-progress": {
        const toolCallId = `${step.name}-call-1`;
        const args =
          scenario === "progress-native-unified"
            ? { path: "src/native-card.ts", content: "const unified = true;\n" }
            : undefined;
        if (step.phase === "start") {
          await turn.replyOptions.onItemEvent?.(
            projectAgentToolActivity({ toolCallId, name: step.name, phase: "start", args }),
          );
          await turn.replyOptions.onToolStart?.({
            toolCallId,
            name: step.name,
            phase: "start",
            args,
          });
        } else {
          await turn.replyOptions.onItemEvent?.(
            projectAgentToolActivity({
              toolCallId,
              name: step.name,
              phase: "result",
              status: "completed",
              args,
            }),
          );
        }
        // The mocked core dispatcher owns default tool progress messages; when
        // dispatch did not suppress them it would deliver a tool-kind payload,
        // so the script forwards a deterministic stand-in text.
        if (turn.replyOptions.suppressDefaultToolProgressMessages !== true) {
          await deliver({ text: `Using tool: ${step.name} (${step.phase})` }, "tool");
        }
        break;
      }
      case "final":
        await deliver(
          {
            ...(step.text !== undefined ? { text: step.text } : {}),
            ...(step.mediaUrls ? { mediaUrls: step.mediaUrls } : {}),
            ...(step.isError ? { isError: true } : {}),
            ...(scenario === "final-blocks-and-text"
              ? { presentation: BLOCKS_FINAL_PRESENTATION }
              : {}),
          } as ReplyPayload,
          "final",
        );
        break;
      case "cancel":
        // An aborted run stops emitting payloads; closeout happens on idle.
        break;
      case "idle": {
        turn.options.typingCallbacks?.onIdle?.();
        turn.options.typingCallbacks?.onCleanup?.();
        // Let the fire-and-forget typing stop record before post-turn finalize,
        // matching the production settle-then-finalize order.
        await vi.advanceTimersByTimeAsync(0);
        traceState.turnOutcome?.resolve({
          queuedFinal: traceState.counts.final > 0,
          counts: { ...traceState.counts },
        });
        await traceState.dispatchDone;
        break;
      }
      case "block-final":
        // Native streaming turns run with disableBlockStreaming=true, so the
        // dispatcher never emits block-kind payloads on this wiring.
        throw new Error("slack trace scenarios do not script block-final steps");
      case "wire-fault":
        throw new Error("slack trace scenarios script wire faults via the recording client");
    }
  };
}

describe("slack delivery trace goldens", () => {
  it.each([
    {
      name: "explicit progress mode",
      streaming: { mode: "progress" as const },
      typingReaction: undefined,
      emoji: "hourglass_flowing_sand",
    },
    {
      name: "thread-only native cards",
      streaming: { progress: { nativeTaskCards: true } },
      typingReaction: undefined,
      emoji: "hourglass_flowing_sand",
    },
    {
      name: "empty card with hidden tool activity",
      streaming: {
        progress: { style: "card" as const, nativeTaskCards: false, toolProgress: false },
      },
      typingReaction: "",
      emoji: undefined,
    },
  ])(
    "leaves only the final answer on a top-level turn with $name",
    async ({ streaming, typingReaction, emoji }) => {
      const events = await runDeliveryTraceScenario({
        scenario: { name: "quiet-top-level", steps: slackTraceScenarios["progress-session-card"] },
        setup: (recorder) =>
          setupSlackTrace(recorder, "progress-session-card", (prepared) => {
            prepared.replyToMode = "off";
            prepared.account.config = { streaming, typingReaction };
            prepared.ctx.typingReaction = typingReaction ?? "";
          }),
      });
      const out = events.filter((event) => event.dir === "out");
      expect(out.map((event) => event.kind)).toEqual(
        emoji ? ["reactions.add", "chat.postMessage", "reactions.remove"] : ["chat.postMessage"],
      );
      expect(collectSlackWireTexts(events)).toEqual(["The session card is complete."]);
      for (const reaction of out.filter((event) => event.kind.startsWith("reactions."))) {
        expect(reaction.data).toMatchObject({
          payload: { channel: CHANNEL_ID, timestamp: INBOUND_TS, name: emoji },
        });
      }
      expect(traceRuntimeError).not.toHaveBeenCalled();
    },
  );

  it("shows top-level commentary with only root commentary opted in", async () => {
    const events = await runDeliveryTraceScenario({
      scenario: {
        name: "explicit-top-level-commentary",
        steps: slackTraceScenarios["progress-compact-commentary"],
      },
      setup: (recorder) =>
        setupSlackTrace(recorder, "progress-compact-commentary", (prepared) => {
          prepared.replyToMode = "off";
          prepared.ctx.cfg.channels = {
            slack: {
              streaming: { progress: { commentary: true } },
              accounts: {
                default: {
                  streaming: {
                    progress: { nativeTaskCards: true },
                  },
                },
              },
            },
          };
          prepared.account.config = mergeSlackAccountConfig(prepared.ctx.cfg, "default");
        }),
    });
    expect(traceState.turn?.replyOptions).toMatchObject({
      commentaryProgressEnabled: true,
      commentaryPayloadsEnabled: true,
    });
    const wireTexts = collectSlackWireTexts(events);
    expect(wireTexts.some((text) => text.includes(COMPACT_COMMENTARY_TEXT_UPDATED))).toBe(true);
    expect(wireTexts.filter((text) => text === COMPACT_FINAL_TEXT)).toHaveLength(1);
    expect(events.some((event) => event.kind.startsWith("reactions."))).toBe(false);
    expect(traceRuntimeError).not.toHaveBeenCalled();
  });

  it.each([
    { name: "error", isError: true, title: "Failed", label: undefined },
    { name: "explicit title only", isError: false, title: "Review", label: "Review" },
  ])(
    "keeps an explicit top-level card with the $name terminal title",
    async ({ isError, title, label }) => {
      const events = await runDeliveryTraceScenario({
        scenario: {
          name: "explicit-top-level-card",
          steps: [
            { kind: "reply-start" },
            { kind: "tool-progress", name: "read", phase: "start" },
            { kind: "advance", ms: 2000 },
            { kind: "final", text: "The answer.", isError },
            { kind: "idle" },
          ],
        },
        setup: (recorder) =>
          setupSlackTrace(recorder, "progress-session-card", (prepared) => {
            prepared.replyToMode = "off";
            prepared.account.config = {
              streaming: { progress: { style: "card", toolProgress: true, label } },
            };
          }),
      });
      const posts = events.filter((event) => event.kind === "chat.postMessage");
      expect(posts).toHaveLength(2);
      expect(posts[0]?.data).toMatchObject({
        payload: {
          text: `${label ? `${label}\n\n` : ""}Read — running\n\n1 tool · 2s`,
        },
      });
      expect(posts[1]?.data).toMatchObject({ payload: { text: "The answer." } });
      expect(events.findLast((event) => event.kind === "chat.update")?.data).toMatchObject({
        payload: {
          text: `${title ? `${title}\n\n` : ""}Read — running\n\nOpen in OpenClaw`,
        },
      });
      expect(
        events.some((event) => event.kind === "chat.delete" || event.kind.startsWith("reactions.")),
      ).toBe(false);
    },
  );

  it.each([
    {
      surface: "native",
      sessionKey: `agent:trace-agent:slack:channel:c0trace:thread:${INBOUND_TS}`,
      path: "/slack/channel/c0trace/thread/1767225600%2E000100",
    },
    {
      surface: "card",
      sessionKey: `agent:trace-agent:slack:channel:c0trace:thread:${INBOUND_TS}`,
      path: "/slack/channel/c0trace/thread/1767225600%2E000100",
    },
  ])(
    "links the dispatched $sessionKey from the $surface surface",
    async ({ surface, sessionKey, path }) => {
      const events = await runDeliveryTraceScenario({
        scenario: {
          name: "dispatched-session-link",
          steps: slackTraceScenarios["progress-session-card"],
        },
        setup: (recorder) =>
          setupSlackTrace(recorder, "progress-session-card", (prepared) => {
            prepared.message.thread_ts = INBOUND_TS;
            prepared.message.ts = "1767225600.000200";
            prepared.replyToMode = "off";
            prepared.ctxPayload.SessionKey = sessionKey;
            prepared.ctx.cfg.session = { mainKey: "inbox" };
            if (surface === "native") {
              prepared.account.config = {};
            }
          }),
      });
      const out = events.filter((event) => event.dir === "out");
      const url = `https://team.openclaw.ai/openclaw/chat/trace-agent${path}`;
      if (surface === "native") {
        expect(out.some((event) => event.kind === "chat.postMessage")).toBe(false);
        expect(out.filter((event) => event.kind === "chat.startStream")).toHaveLength(1);
        expect(out.find((event) => event.kind === "chat.startStream")?.data).toMatchObject({
          payload: { thread_ts: INBOUND_TS, task_display_mode: "plan" },
        });
        expect(out).toContainEqual(
          expect.objectContaining({
            kind: "chat.appendStream",
            data: expect.objectContaining({
              payload: expect.objectContaining({
                chunks: expect.arrayContaining([
                  expect.objectContaining({
                    type: "task_update",
                    id: "openclaw_summary",
                    title: "Completed",
                    status: "complete",
                    sources: [{ type: "url_source", url, text: "Open in OpenClaw" }],
                  }),
                ]),
              }),
            }),
          }),
        );
        expect(
          collectSlackWireTexts(events).filter((text) =>
            text.includes("The session card is complete."),
          ),
        ).toHaveLength(1);
      } else {
        const terminal = out.findLast((event) => event.kind === "chat.update");
        expect(terminal?.data).toMatchObject({
          payload: {
            blocks: expect.arrayContaining([
              expect.objectContaining({
                type: "actions",
                elements: [expect.objectContaining({ type: "button", url })],
              }),
            ]),
          },
        });
      }
    },
  );

  const headSha = process.env.OPENCLAW_DELIVERY_PROOF_SHA ?? "";
  for (const scenarioName of [
    "short-final-native-rejection",
    "final-blocks-and-text",
    "cancel-mid-stream",
    "progress-compact-commentary",
    "progress-native-unified",
    "native-prose-then-exec-failed",
    "preview-exec-failed-then-prose",
  ] as const) {
    it(`records ${scenarioName}`, async () => {
      const events = await runDeliveryTraceScenario({
        scenario: { name: scenarioName, steps: slackTraceScenarios[scenarioName] },
        setup: (recorder) => setupSlackTrace(recorder, scenarioName),
        normalize: createSlackTsNormalizer(),
      });
      expectDeliveryTraceMatchesGolden({
        goldenUrl: new URL(`./__traces__/${scenarioName}.trace.jsonl`, import.meta.url),
        events,
      });
      const wireTexts = collectSlackWireTexts(events);
      expect(wireTexts.join("\n")).not.toMatch(/Exec failed/i);
      if (
        scenarioName === "native-prose-then-exec-failed" ||
        scenarioName === "preview-exec-failed-then-prose"
      ) {
        expect(wireTexts.some((text) => text.includes(EXEC_FAILED_PROSE))).toBe(true);
        if (process.env.OPENCLAW_DELIVERY_PROOF === "1") {
          process.stdout.write(
            `${JSON.stringify(buildSlackDeliveryProofVerdict({ scenario: scenarioName, events, headSha, expectedProse: EXEC_FAILED_PROSE }), null, 2)}\n`,
          );
        }
      }
    });
  }

  it("discards a Slack-stopped native stream without a duplicate final or stop request", async () => {
    let streamTs: string | undefined;
    const events = await runDeliveryTraceScenario({
      scenario: {
        name: "slack-stopped-native-stream",
        steps: [
          { kind: "reply-start" },
          { kind: "partial", text: NATIVE_PROGRESS_NARRATION },
          { kind: "tool-progress", name: "write", phase: "start" },
          // The progress compositor emits its initial card at 1500ms.
          { kind: "advance", ms: 2000 },
          { kind: "cancel" },
          { kind: "final", text: "Late answer that must not be posted" },
          { kind: "idle" },
        ],
      },
      setup: async (recorder) => {
        const handleStep = await setupSlackTrace(
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
            markSlackStreamsStopped(traceState.client as unknown as WebClient, CHANNEL_ID, [
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
    expect(traceRuntimeError).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps top-level native output below later ingress (Slack Stop: %s)",
    async (stoppedBySlack) =>
      assertSlackSteeringTransportTrace({
        stoppedBySlack,
        channelId: CHANNEL_ID,
        inboundTs: INBOUND_TS,
        setup: (recorder) => setupSlackTrace(recorder, "streaming-happy-native"),
        getClient: () => traceState.client as unknown as WebClient,
        assertNoRuntimeError: () => expect(traceRuntimeError).not.toHaveBeenCalled(),
      }),
  );

  it("removes a progress card detached by a later human message", async () => {
    let progressEvents = 0;
    const events = await runDeliveryTraceScenario({
      scenario: {
        name: "progress-session-card-detached",
        steps: [
          { kind: "reply-start" },
          { kind: "tool-progress", name: "read", phase: "start" },
          { kind: "advance", ms: 2000 },
          { kind: "tool-progress", name: "write", phase: "start" },
          { kind: "advance", ms: 2000 },
          { kind: "final", text: "The replacement session card is complete." },
          { kind: "idle" },
        ],
      },
      setup: async (recorder) => {
        const dispatch = await setupSlackTrace(recorder, "progress-session-card");
        return async (step) => {
          if (step.kind === "tool-progress") {
            progressEvents += 1;
            if (progressEvents === 2) {
              traceState.tsCounter += 1;
              noteSlackDraftConversationMessage({
                accountId: "default",
                channelId: CHANNEL_ID,
                threadTs: INBOUND_TS,
                messageTs: `1767225601.${String(traceState.tsCounter).padStart(6, "0")}`,
                userId: "U_SECOND",
                botUserId: "UBOT",
              });
            }
          }
          await dispatch(step);
        };
      },
      normalize: createSlackTsNormalizer(),
    });

    const workingPosts = events.filter(
      (event) =>
        event.kind === "chat.postMessage" && JSON.stringify(event.data).includes('"blocks"'),
    );
    expect(workingPosts).toHaveLength(2);
    const firstCardId = (workingPosts[0]?.data as { result?: { ts?: string } } | undefined)?.result
      ?.ts;
    const secondCardId = (workingPosts[1]?.data as { result?: { ts?: string } } | undefined)?.result
      ?.ts;
    expect(firstCardId).toBeTruthy();
    expect(secondCardId).toBeTruthy();
    expect(
      events.some(
        (event) =>
          event.kind === "chat.delete" &&
          (event.data as { target?: string } | undefined)?.target === firstCardId,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.kind === "chat.update" &&
          (event.data as { target?: string } | undefined)?.target === secondCardId &&
          JSON.stringify(event.data).includes("Open in OpenClaw"),
      ),
    ).toBe(true);
  });
});
