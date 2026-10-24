import type { WebClient } from "@slack/web-api";
// Scripted agent turns drive real dispatch, delivery, and SDK buffering; only
// Slack I/O is recorded. Refresh goldens with OPENCLAW_TRACE_UPDATE=1.
import { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceStep,
  type TraceEvent,
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
  collectSlackWireTexts,
  createSlackTsNormalizer,
  assertSlackProgressMentionHttpTrace,
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

type CapturedTurn = Parameters<
  typeof import("openclaw/plugin-sdk/channel-inbound").dispatchChannelInboundTurn
>[0];
type TurnCounts = Record<ReplyDispatchKind, number>;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

type SlackTraceState = {
  recordWireCall: (call: RecordedWireCall) => void;
  client: Record<string, unknown> | null;
  turn: CapturedTurn | null;
  turnStarted: Deferred<void> | null;
  turnOutcome: Deferred<{ queuedFinal: boolean; counts: TurnCounts }> | null;
  dispatchDone: Promise<void> | null;
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
  tsCounter: 0,
  rejectStartStreamCode: undefined,
}));

// Replace the agent turn, not the downstream delivery lifecycle.
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    dispatchChannelInboundTurn: async (params: CapturedTurn) => {
      traceState.turn = params;
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
// Matches the harness's fake-clock epoch.
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

function turnSteps(...steps: DeliveryTraceStep[]): DeliveryTraceStep[] {
  return [{ kind: "reply-start" }, ...steps, { kind: "idle" }];
}

// Scenario names key the golden filenames.
const slackTraceScenarios: Record<
  Exclude<SlackTraceScenarioName, "streaming-happy-native">,
  readonly DeliveryTraceStep[]
> = {
  "short-final-native-rejection": turnSteps(
    { kind: "partial", text: "All checks passed." },
    { kind: "advance", ms: 300 },
    { kind: "final", text: SHORT_FINAL_TEXT },
  ),
  "final-blocks-and-text": turnSteps({ kind: "final", text: BLOCKS_FINAL_TEXT }),
  "cancel-mid-stream": turnSteps(
    { kind: "partial", text: "Working on the fix" },
    { kind: "advance", ms: 300 },
    { kind: "partial", text: "Working on the fix: patching now." },
    // Past the draft throttle (1000ms) so the second preview edit lands
    // before the run is aborted.
    { kind: "advance", ms: 1100 },
    { kind: "cancel" },
  ),
  "progress-compact-commentary": turnSteps(
    { kind: "partial", text: COMPACT_COMMENTARY_TEXT },
    { kind: "advance", ms: 2000 },
    { kind: "tool-progress", name: "read", phase: "start" },
    { kind: "partial", text: COMPACT_COMMENTARY_TEXT_UPDATED },
    { kind: "advance", ms: 2000 },
    { kind: "final", text: COMPACT_FINAL_TEXT },
  ),
  "progress-session-card": turnSteps(
    { kind: "tool-progress", name: "read", phase: "start" },
    { kind: "advance", ms: 2000 },
    { kind: "tool-progress", name: "read", phase: "result" },
    { kind: "final", text: "The session card is complete." },
  ),
  "progress-native-unified": turnSteps(
    { kind: "partial", text: NATIVE_PROGRESS_NARRATION },
    { kind: "tool-progress", name: "write", phase: "start" },
    { kind: "advance", ms: 2000 },
    { kind: "partial", text: NATIVE_PROGRESS_NARRATION_UPDATED },
    { kind: "tool-progress", name: "write", phase: "result" },
    { kind: "final", text: "The unified native Slack turn is complete." },
  ),
  "native-prose-then-exec-failed": turnSteps(
    { kind: "final", text: EXEC_FAILED_PROSE },
    { kind: "final", text: EXEC_FAILED_TRACE },
  ),
  "preview-exec-failed-then-prose": turnSteps(
    { kind: "partial", text: EXEC_FAILED_TRACE },
    { kind: "advance", ms: 1100 },
    { kind: "partial", text: EXEC_FAILED_PROSE },
    { kind: "advance", ms: 1100 },
    { kind: "final", text: EXEC_FAILED_PROSE },
  ),
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
  const record = (
    method: string,
    args: Record<string, unknown>,
    target: unknown,
    result?: unknown,
  ) => {
    traceState.recordWireCall({
      method,
      target: asWireString(target),
      payload: stripToken(args),
      result,
    });
  };
  const unexpected = (method: string) => async () => {
    throw new Error(`unexpected Slack wire call: ${method}`);
  };
  const acknowledge =
    (method: string, includeChannel = false) =>
    async (args: Record<string, unknown>) => {
      record(method, args, args.ts, { ok: true });
      return { ok: true, ts: args.ts, ...(includeChannel ? { channel: args.channel } : {}) };
    };
  const client: Record<string, unknown> = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        const ts = nextSlackTs();
        record("chat.postMessage", args, args.channel, { ts });
        return {
          ok: true,
          channel: args.channel,
          ts,
          message: { ts, ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}) },
        };
      },
      update: acknowledge("chat.update", true),
      delete: async (args: Record<string, unknown>) => {
        record("chat.delete", args, args.ts, { ok: true });
        return { ok: true };
      },
      startStream: async (args: Record<string, unknown>) => {
        const rejectCode = traceState.rejectStartStreamCode;
        if (rejectCode) {
          traceState.rejectStartStreamCode = undefined;
          record("chat.startStream", args, args.channel, { ok: false, error: rejectCode });
          const err = new Error(`An API error occurred: ${rejectCode}`);
          (err as Error & { data?: unknown }).data = { ok: false, error: rejectCode };
          throw err;
        }
        const ts = nextSlackTs();
        record("chat.startStream", args, args.channel, { ts });
        return { ok: true, ts };
      },
      appendStream: acknowledge("chat.appendStream"),
      stopStream: acknowledge("chat.stopStream"),
    },
    users: {
      info: async (args: Record<string, unknown>) => {
        record("users.info", args, args.user, { team_id: TEAM_ID });
        return { ok: true, user: { team_id: TEAM_ID } };
      },
    },
    apiCall: async (method: string, args: Record<string, unknown>) => {
      record(method, args, `${asWireString(args.channel_id)}/${asWireString(args.thread_ts)}`, {
        ok: true,
      });
      return { ok: true };
    },
    conversations: { open: unexpected("conversations.open") },
    reactions: Object.fromEntries(
      ["add", "remove"].map((action) => [
        action,
        async (args: Record<string, unknown>) => {
          traceState.recordWireCall({ method: `reactions.${action}`, payload: stripToken(args) });
          return { ok: true };
        },
      ]),
    ),
  };
  // Let the real SDK own buffering.
  client.chatStream = (args: unknown) =>
    new ChatStreamer(client as never, { debug: () => {} } as never, args as never, {});
  return client;
}

function createPreparedTraceMessage(scenario: SlackTraceScenarioName): PreparedSlackMessage {
  const progressCard = scenario === "progress-session-card";
  const nativeProgress = scenario === "progress-native-unified";
  const progressModes = {
    "progress-compact-commentary": {
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
    "progress-session-card": { progress: { nativeTaskCards: false, toolProgress: true } },
    "progress-native-unified": { mode: "progress", progress: { toolProgress: true } },
  } satisfies Partial<
    Record<
      SlackTraceScenarioName,
      NonNullable<PreparedSlackMessage["account"]["config"]["streaming"]>
    >
  >;
  const streaming =
    scenario === "progress-compact-commentary" || progressCard || nativeProgress
      ? progressModes[scenario]
      : { mode: "partial", nativeTransport: NATIVE_SCENARIOS.has(scenario) };
  const cfg: OpenClawConfig = { channels: { slack: { enabled: true } } };
  if (progressCard || nativeProgress) {
    cfg.gateway = {
      publicOrigin: "https://team.openclaw.ai",
      controlUi: { basePath: "/openclaw" },
    };
  }
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
      config: { streaming },
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
  httpClient?: WebClient,
) {
  traceState.recordWireCall = recorder.recordWireCall;
  traceState.tsCounter = 0;
  traceRuntimeError.mockClear();
  const counts: TurnCounts = { tool: 0, block: 0, final: 0 };
  traceState.turn = null;
  traceState.turnStarted = createDeferred<void>();
  traceState.turnOutcome = createDeferred<{ queuedFinal: boolean; counts: TurnCounts }>();
  traceState.rejectStartStreamCode =
    scenario === "short-final-native-rejection"
      ? "method_not_supported_for_channel_type"
      : undefined;
  traceState.client = httpClient
    ? (httpClient as unknown as Record<string, unknown>)
    : createRecordingSlackClient();

  const prepared = createPreparedTraceMessage(scenario);
  configure?.(prepared);
  const dispatchDone = dispatchPreparedSlackMessage(prepared);
  traceState.dispatchDone = dispatchDone;
  await traceState.turnStarted.promise;
  const turn = traceState.turn as SlackTraceState["turn"];
  if (!turn) {
    throw new Error("trace turn wiring was not captured");
  }
  const { dispatcherOptions: options, delivery, replyOptions = {} } = turn;

  const deliver = async (payload: ReplyPayload, kind: ReplyDispatchKind) => {
    const transformed = options?.transformReplyPayload
      ? options.transformReplyPayload(payload)
      : payload;
    if (!transformed) {
      return;
    }
    try {
      await delivery.deliver(transformed, { kind });
      counts[kind] += 1;
    } catch (err) {
      // Mirrors the reply dispatcher: failed deliveries report onError and are
      // not counted as dispatched.
      delivery.onError?.(err, { kind });
    }
  };

  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start":
        await options?.typingCallbacks?.onReplyStart?.();
        break;
      case "partial":
        if (scenario === "progress-compact-commentary" || scenario === "progress-native-unified") {
          await replyOptions.onItemEvent?.({
            kind: "preamble",
            itemId: "preamble-1",
            progressText: step.text,
          });
          if (scenario === "progress-native-unified") {
            await deliver({ text: step.text, isCommentary: true }, "block");
          }
        } else {
          await replyOptions.onPartialReply?.({ text: step.text });
        }
        break;
      case "tool-progress": {
        const activity = {
          toolCallId: `${step.name}-call-1`,
          name: step.name,
          phase: step.phase,
          args:
            scenario === "progress-native-unified"
              ? { path: "src/native-card.ts", content: "const unified = true;\n" }
              : undefined,
        };
        await replyOptions.onItemEvent?.(
          projectAgentToolActivity({
            ...activity,
            ...(step.phase === "result" ? { status: "completed" as const } : {}),
          }),
        );
        if (step.phase === "start") {
          await replyOptions.onToolStart?.(activity);
        }
        // Mirror the core dispatcher's default tool progress delivery.
        if (replyOptions.suppressDefaultToolProgressMessages !== true) {
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
        options?.typingCallbacks?.onIdle?.();
        options?.typingCallbacks?.onCleanup?.();
        // Let the fire-and-forget typing stop record before post-turn finalize,
        // matching the production settle-then-finalize order.
        await vi.advanceTimersByTimeAsync(0);
        traceState.turnOutcome?.resolve({
          queuedFinal: counts.final > 0,
          counts: { ...counts },
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

function runSlackTrace(
  scenario: keyof typeof slackTraceScenarios,
  options: {
    name?: string;
    steps?: readonly DeliveryTraceStep[];
    configure?: Parameters<typeof setupSlackTrace>[2];
    record?: (call: RecordedWireCall) => void;
    beforeStep?: (step: DeliveryTraceInStep) => void;
    normalize?: boolean;
  } = {},
) {
  const {
    name = scenario,
    steps = slackTraceScenarios[scenario],
    configure,
    record,
    beforeStep,
    normalize,
  } = options;
  return runDeliveryTraceScenario({
    scenario: { name, steps },
    setup: async (recorder) => {
      const dispatch = await setupSlackTrace(
        {
          recordWireCall(call) {
            record?.(call);
            recorder.recordWireCall(call);
          },
        },
        scenario,
        configure,
      );
      if (!beforeStep) {
        return dispatch;
      }
      return async (step) => {
        beforeStep(step);
        await dispatch(step);
      };
    },
    normalize: normalize ? createSlackTsNormalizer() : undefined,
  });
}

function wirePayloads(events: readonly TraceEvent[], method: string) {
  return events
    .filter((event) => event.kind === method)
    .map((event) => (event.data as { payload?: unknown } | undefined)?.payload);
}

describe("slack delivery trace goldens", () => {
  it.each(["compact", "inferred-compact", "partial", "card"] as const)(
    "keeps native mention policy through serialized %s posts and edits",
    async (mode) => {
      await assertSlackProgressMentionHttpTrace({
        mode,
        setup: (recorder, client) =>
          setupSlackTrace(
            recorder,
            mode === "partial" ? "cancel-mid-stream" : "progress-compact-commentary",
            (prepared) => {
              if (mode !== "partial") {
                prepared.account.config.streaming = {
                  mode: "progress",
                  progress: {
                    ...(mode === "inferred-compact" ? {} : { style: mode }),
                    nativeTaskCards: false,
                    label: false,
                    maxLineChars: 1000,
                    commentary: true,
                    toolProgress: false,
                  },
                };
              }
            },
            client,
          ),
      });
      expect(traceRuntimeError).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["explicit progress mode", { mode: "progress" }, undefined, "hourglass_flowing_sand"],
    [
      "thread-only native cards",
      { progress: { nativeTaskCards: true } },
      undefined,
      "hourglass_flowing_sand",
    ],
    [
      "empty card with hidden tool activity",
      { progress: { style: "card", nativeTaskCards: false, toolProgress: false } },
      "",
      undefined,
    ],
  ] as const)(
    "leaves only the final answer on a top-level turn with %s",
    async (_name, streaming, typingReaction, emoji) => {
      const events = await runSlackTrace("progress-session-card", {
        name: "quiet-top-level",
        configure: (prepared) => {
          prepared.replyToMode = "off";
          prepared.account.config = { streaming, typingReaction };
          prepared.ctx.typingReaction = typingReaction ?? "";
        },
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
    const events = await runSlackTrace("progress-compact-commentary", {
      name: "explicit-top-level-commentary",
      configure: (prepared) => {
        prepared.replyToMode = "off";
        prepared.ctx.cfg.channels = {
          slack: {
            streaming: { progress: { commentary: true } },
            accounts: { default: { streaming: { progress: { nativeTaskCards: true } } } },
          },
        };
        prepared.account.config = mergeSlackAccountConfig(prepared.ctx.cfg, "default");
      },
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
      const events = await runSlackTrace("progress-session-card", {
        name: "explicit-top-level-card",
        steps: turnSteps(
          { kind: "tool-progress", name: "read", phase: "start" },
          { kind: "advance", ms: 2000 },
          { kind: "final", text: "The answer.", isError },
        ),
        configure: (prepared) => {
          prepared.replyToMode = "off";
          prepared.account.config = {
            streaming: { progress: { style: "card", toolProgress: true, label } },
          };
        },
      });
      expect(wirePayloads(events, "chat.postMessage")).toMatchObject([
        { text: `${label ? `${label}\n\n` : ""}Read — running\n\n1 tool · 2s` },
        { text: "The answer." },
      ]);
      expect(wirePayloads(events, "chat.update").at(-1)).toMatchObject({
        text: `${title ? `${title}\n\n` : ""}Read — running\n\nOpen in OpenClaw`,
      });
      expect(
        events.some((event) => event.kind === "chat.delete" || event.kind.startsWith("reactions.")),
      ).toBe(false);
    },
  );

  it.each(["native", "card"])(
    "links the dispatched session from the %s surface",
    async (surface) => {
      const events = await runSlackTrace("progress-session-card", {
        name: "dispatched-session-link",
        configure: (prepared) => {
          prepared.message.thread_ts = INBOUND_TS;
          prepared.message.ts = "1767225600.000200";
          prepared.replyToMode = "off";
          prepared.ctxPayload.SessionKey = `agent:trace-agent:slack:channel:c0trace:thread:${INBOUND_TS}`;
          prepared.ctx.cfg.session = { mainKey: "inbox" };
          if (surface === "native") {
            prepared.account.config = {};
          }
        },
      });
      const out = events.filter((event) => event.dir === "out");
      const url =
        "https://team.openclaw.ai/openclaw/chat/trace-agent/slack/channel/c0trace/thread/1767225600%2E000100";
      if (surface === "native") {
        expect(out.some((event) => event.kind === "chat.postMessage")).toBe(false);
        expect(out.filter((event) => event.kind === "chat.startStream")).toHaveLength(1);
        expect(wirePayloads(out, "chat.startStream")[0]).toMatchObject({
          thread_ts: INBOUND_TS,
          task_display_mode: "plan",
        });
        expect(wirePayloads(out, "chat.appendStream")).toContainEqual(
          expect.objectContaining({
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
        );
        expect(
          collectSlackWireTexts(events).filter((text) =>
            text.includes("The session card is complete."),
          ),
        ).toHaveLength(1);
      } else {
        expect(wirePayloads(out, "chat.update").at(-1)).toMatchObject({
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: "actions",
              elements: [expect.objectContaining({ type: "button", url })],
            }),
          ]),
        });
      }
    },
  );

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
      const events = await runSlackTrace(scenarioName, { normalize: true });
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
      }
    });
  }

  it("discards a Slack-stopped native stream without a duplicate final or stop request", async () => {
    let streamTs: string | undefined;
    const events = await runSlackTrace("progress-native-unified", {
      name: "slack-stopped-native-stream",
      steps: turnSteps(
        { kind: "partial", text: NATIVE_PROGRESS_NARRATION },
        { kind: "tool-progress", name: "write", phase: "start" },
        // The progress compositor emits its initial card at 1500ms.
        { kind: "advance", ms: 2000 },
        { kind: "cancel" },
        { kind: "final", text: "Late answer that must not be posted" },
      ),
      record: (call) => {
        if (call.method === "chat.startStream") {
          streamTs = (call.result as { ts?: string })?.ts;
        }
      },
      beforeStep: (step) => {
        if (step.kind === "cancel") {
          expect(streamTs).toBeDefined();
          markSlackStreamsStopped(traceState.client as unknown as WebClient, CHANNEL_ID, [
            streamTs!,
          ]);
        }
      },
      normalize: true,
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
    const events = await runSlackTrace("progress-session-card", {
      name: "progress-session-card-detached",
      steps: turnSteps(
        { kind: "tool-progress", name: "read", phase: "start" },
        { kind: "advance", ms: 2000 },
        { kind: "tool-progress", name: "write", phase: "start" },
        { kind: "advance", ms: 2000 },
        { kind: "final", text: "The replacement session card is complete." },
      ),
      beforeStep: (step) => {
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
      },
      normalize: true,
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
