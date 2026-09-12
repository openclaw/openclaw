import { WebClient } from "@slack/web-api";
import type { dispatchChannelInboundTurn } from "openclaw/plugin-sdk/channel-inbound";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import { getOptionalSlackRuntime, setSlackRuntime } from "../runtime.js";
import { clearSlackThreadParticipationCache } from "../sent-thread-cache.js";
import type { SlackMessageEvent } from "../types.js";
import { createSlackMessageHandler } from "./message-handler.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./message-handler/prepare.test-helpers.js";

export type InflightDispatchParams = Parameters<typeof dispatchChannelInboundTurn>[0];
type DispatchResult = Awaited<ReturnType<typeof dispatchChannelInboundTurn>>;
type Counts = { tool: number; block: number; final: number };
type Outcome = { queuedFinal: boolean; counts: Counts };

type WireCall = {
  method: string;
  channel?: string;
  threadTs?: string;
  text?: string;
};

export type ScriptedInflightTurn = {
  params: InflightDispatchParams;
  finish: (text?: string) => Promise<void>;
  fail: (error: Error) => void;
};

/** Real Slack pipeline and stores; only the agent turn and Web API responses are scripted. */
export function createInflightSlackPipeline(params: {
  stateDir: string;
  threadParticipation: boolean;
}) {
  const sessionFixture = createSlackSessionStoreFixture("openclaw-slack-inflight-pipeline-");
  sessionFixture.setup();
  const { storePath } = sessionFixture.makeTmpStorePath();
  const apiCalls: WireCall[] = [];
  const incoming: SlackMessageEvent[] = [];
  let outboundId = 0;
  const api = vi.spyOn(WebClient.prototype, "apiCall").mockImplementation(async (method, args) => {
    apiCalls.push({
      method,
      ...(typeof args?.channel === "string" ? { channel: args.channel } : {}),
      ...(typeof args?.thread_ts === "string" ? { threadTs: args.thread_ts } : {}),
      ...(typeof args?.text === "string" ? { text: args.text } : {}),
    });
    switch (method) {
      case "conversations.info":
        return {
          ok: true,
          channel: { id: args?.channel, name: "proof", is_channel: true, is_member: true },
        };
      case "users.info":
        return {
          ok: true,
          user: { id: args?.user, name: "tester", real_name: "Test User", team_id: "T1" },
        };
      case "conversations.replies":
        return {
          ok: true,
          messages: incoming.filter(
            (message) =>
              message.channel === args?.channel &&
              (message.ts === args?.ts || message.thread_ts === args?.ts),
          ),
          has_more: false,
        };
      case "conversations.history":
        return { ok: true, messages: [], has_more: false };
      case "chat.postMessage":
        outboundId += 1;
        return {
          ok: true,
          channel: args?.channel,
          ts: `1700000010.${String(outboundId).padStart(6, "0")}`,
        };
      case "agents.sessions.setStatus":
        return { ok: true };
      default:
        throw new Error(`Unexpected Slack Web API method: ${method}`);
    }
  });
  const client = new WebClient("xoxb-synthetic");
  const cfg: OpenClawConfig = {
    session: { store: storePath },
    messages: { inbound: { debounceMs: 0 }, ackReaction: "" },
    channels: {
      slack: {
        enabled: true,
        botToken: "xoxb-synthetic",
        replyToMode: "all",
        streaming: { mode: "off" },
        implicitMentions: { threadParticipation: params.threadParticipation },
      },
    },
  };
  const previousRuntime = getOptionalSlackRuntime();
  const openKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("slack", {
      ...options,
      env: { ...options.env, OPENCLAW_STATE_DIR: params.stateDir },
    });
  const runtime = createPluginRuntimeMock({
    channel: { inbound: { buildContext: buildChannelInboundEventContext } },
    state: { openKeyedStore },
  });
  setSlackRuntime(runtime);
  const persistedParticipation = openKeyedStore<{ repliedAt: number }>({
    namespace: "slack.thread-participation",
    maxEntries: 1000,
  });
  const ctx = createInboundSlackTestContext({
    cfg,
    appClient: client,
    replyToMode: "all",
    channelRuntime: runtime.channel,
  });
  // Exercise the real context builder and session-store fallback, not optional
  // runtime fixture mocks; the core agent dispatcher itself is scripted below.
  ctx.channelRuntime = undefined;
  ctx.dispatchReplyFromConfig = undefined;
  const runtimeErrors: unknown[] = [];
  ctx.runtime.error = (error) => runtimeErrors.push(error);
  const handler = createSlackMessageHandler({
    ctx,
    account: createSlackTestAccount(cfg.channels?.slack),
  });
  const turns: ScriptedInflightTurn[] = [];
  const gates = new Set<ReturnType<typeof createDeferred<Outcome>>>();
  const ready = new Map<string, ReturnType<typeof createDeferred<ScriptedInflightTurn>>>();
  const completions: Promise<void>[] = [];
  let closing = false;

  const dispatchCore = async (input: InflightDispatchParams): Promise<DispatchResult> => {
    const sid = input.ctxPayload.MessageSid;
    if (typeof sid !== "string") {
      throw new Error("Prepared Slack turn is missing MessageSid");
    }
    const outcome = createDeferred<Outcome>();
    gates.add(outcome);
    const counts: Counts = { tool: 0, block: 0, final: 0 };
    const turn: ScriptedInflightTurn = {
      params: input,
      finish: async (text) => {
        if (text !== undefined) {
          const authored = { text };
          const transform = input.dispatcherOptions?.transformReplyPayload;
          const reply = transform ? transform(authored) : authored;
          if (reply) {
            await input.delivery.deliver(reply, { kind: "final" });
            counts.final += 1;
          }
        }
        outcome.resolve({ queuedFinal: counts.final > 0, counts });
      },
      fail: (error) => outcome.reject(error),
    };
    // The actual dispatch owner registered its publisher before this core seam.
    // Release immediate debounce admission exactly when core adopts the turn.
    await input.replyOptions?.turnAdoptionLifecycle?.onAdopted();
    turns.push(turn);
    ready.get(sid)?.resolve(turn);
    if (closing) {
      outcome.resolve({ queuedFinal: false, counts });
    }
    try {
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: input.ctxPayload,
        routeSessionKey: input.route.sessionKey,
        dispatchResult: await outcome.promise,
      };
    } finally {
      gates.delete(outcome);
    }
  };

  return {
    ctx,
    turns,
    apiCalls,
    runtimeErrors,
    dispatchCore,
    async receive(message: SlackMessageEvent, source: "message" | "app_mention" = "message") {
      if (!message.ts) {
        throw new Error("Synthetic message requires a timestamp");
      }
      incoming.push(message);
      const adopted = createDeferred<ScriptedInflightTurn>();
      ready.set(message.ts, adopted);
      const completion = handler(message, { source, awaitDispatch: true });
      completions.push(completion);
      // Attach rejection handling immediately; individual assertions still await
      // the original completion to verify failure propagation.
      void completion.catch(() => {});
      const turn = await Promise.race([adopted.promise, completion.then(() => undefined)]);
      return { turn, completion };
    },
    async persistedParticipant(threadTs: string) {
      return (await persistedParticipation.lookup(`default:C123:${threadTs}`)) !== undefined;
    },
    async close() {
      closing = true;
      for (const gate of gates) {
        gate.resolve({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
      }
      await Promise.allSettled(completions);
      clearSlackThreadParticipationCache();
      setSlackRuntime(previousRuntime ?? (null as never));
      resetPluginStateStoreForTests();
      sessionFixture.cleanup();
      api.mockRestore();
    },
  };
}
