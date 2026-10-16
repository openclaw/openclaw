import { setImmediate } from "node:timers/promises";
import { App } from "@slack/bolt";
import type { createChannelInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import { createSlackMonitorContext } from "./context.js";
import { createSlackMessageHandler } from "./message-handler.js";
import type { PreparedSlackMessage } from "./message-handler/types.js";

type PreparedTestMessage = Pick<PreparedSlackMessage, "turnAdoptionLifecycle"> & {
  route: { sessionKey: string };
  ctxPayload: Record<string, unknown>;
};
type SlackDebouncer = ReturnType<
  typeof createChannelInboundDebouncer<{ message: SlackMessageEvent }>
>["debouncer"];

const { prepare, dispatch, capture } = vi.hoisted(() => ({
  prepare: vi.fn(
    async (_params: { message: SlackMessageEvent }): Promise<PreparedTestMessage | null> => null,
  ),
  dispatch: vi.fn(async (_prepared: PreparedTestMessage) => {}),
  capture: { onCreate: undefined as ((debouncer: SlackDebouncer) => void) | undefined },
}));
// mock-isolation: Exercise real debounce admission with a held dispatcher and minimal prepared messages.
vi.mock("./message-handler/pipeline.runtime.js", () => ({
  prepareSlackMessage: prepare,
  dispatchPreparedSlackMessage: dispatch,
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    createChannelInboundDebouncer: (
      params: Parameters<
        typeof actual.createChannelInboundDebouncer<{ message: SlackMessageEvent }>
      >[0],
    ) => {
      const result = actual.createChannelInboundDebouncer(params);
      capture.onCreate?.(result.debouncer);
      return result;
    },
  };
});

function createHandler(
  cfg: OpenClawConfig,
  abortSignal: AbortSignal,
  dispatchReplayGuard?: Parameters<typeof createSlackMessageHandler>[0]["dispatchReplayGuard"],
) {
  const app = new App({
    token: "synthetic-token",
    signingSecret: "synthetic-signing-secret",
    tokenVerificationEnabled: false,
  });
  return createSlackMessageHandler({
    ctx: createSlackMonitorContext({
      cfg,
      accountId: "default",
      app,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      botToken: "synthetic-token",
      botUserId: "BOT",
      identityHealth: { lifecycle: "ready", lastError: null },
      teamId: "TEAM",
      apiAppId: "APP",
      historyLimit: 0,
      sessionScope: "per-sender",
      mainKey: "main",
      dmEnabled: true,
      dmPolicy: "open",
      allowFrom: [],
      allowNameMatching: false,
      groupDmEnabled: false,
      groupDmChannels: [],
      groupPolicy: "open",
      useAccessGroups: true,
      reactionMode: "off",
      reactionAllowlist: [],
      replyToMode: "off",
      threadHistoryScope: "thread",
      threadInheritParent: false,
      slashCommand: {
        enabled: false,
        name: "openclaw",
        ephemeral: true,
        sessionPrefix: "slack:slash",
      },
      textLimit: 4000,
      typingReaction: "",
      mediaMaxBytes: 1024,
    }),
    abortSignal,
    dispatchReplayGuard,
  });
}

it("updates Slack delay and flushes newly buffered top-level keys before immediate work", async () => {
  const cfg: OpenClawConfig = { messages: { inbound: { debounceMs: 0 } } };
  setRuntimeConfigSnapshot(cfg, cfg);
  prepare.mockClear();
  const abort = new AbortController();
  const handler = createHandler(cfg, abort.signal);
  let sequence = 0;
  const enqueue = (text: string, channel = "D1") =>
    handler(
      { type: "message", channel, user: "USER", ts: `123.${++sequence}`, text },
      { source: "message" },
    );
  const publish = (debounceMs: number) => {
    const current = { messages: { inbound: { debounceMs } } };
    setRuntimeConfigSnapshot(current, current);
  };
  const bodies = () => prepare.mock.calls.map(([params]) => params.message.text);
  vi.useFakeTimers();
  try {
    await enqueue("immediate");
    expect(bodies()).toEqual(["immediate"]);
    publish(25);
    await enqueue("first");
    await enqueue("second");
    expect(bodies()).toEqual(["immediate"]);
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => expect(bodies()).toEqual(["immediate", "first\nsecond"]));
    await enqueue("pending top level", "C1");
    publish(0);
    await enqueue("after disable", "C1");
    expect(bodies()).toEqual(["immediate", "first\nsecond", "pending top level", "after disable"]);
  } finally {
    abort.abort();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    clearRuntimeConfigSnapshot();
  }
});

it.each(["adopted", "accepted deferral"] as const)(
  "flushes pending text to admission before a table-bearing message: %s",
  async (admission) => {
    const cfg: OpenClawConfig = { messages: { inbound: { debounceMs: 25 } } };
    const abort = new AbortController();
    const started = createDeferred<PreparedTestMessage>();
    const complete = createDeferred<void>();
    let completed = false;
    let debouncer: SlackDebouncer | undefined;
    capture.onCreate = (created) => {
      debouncer = created;
      vi.spyOn(created, "flushKey");
      vi.spyOn(created, "enqueue");
    };
    const guard = createChannelReplayGuard<{ keys: readonly string[] }>({
      dedupe: { ttlMs: 60_000, memoryMaxSize: 10 },
      buildReplayKey: (event) => event.keys,
    });
    const first: SlackMessageEvent = {
      type: "message",
      channel: "C111",
      user: "U111",
      ts: "1709000000.000100",
      text: "first buffered text",
    };
    const table: SlackMessageEvent = {
      ...first,
      ts: "1709000000.000200",
      text: "table follows",
      attachments: [{ blocks: [{ type: "table", rows: [[{ type: "raw_text", text: "kept" }]] }] }],
    };
    prepare
      .mockReset()
      .mockImplementation(async ({ message }) =>
        message.ts === first.ts
          ? { route: { sessionKey: "agent:main:slack:channel:C111" }, ctxPayload: {} }
          : null,
      );
    dispatch.mockReset().mockImplementation(async (prepared) => {
      started.resolve(prepared);
      await complete.promise;
      await prepared.turnAdoptionLifecycle?.onAdopted();
      completed = true;
    });
    setRuntimeConfigSnapshot(cfg, cfg);
    vi.useFakeTimers();
    let handlingTable: Promise<void> | undefined;
    try {
      const handler = createHandler(cfg, abort.signal, guard);
      if (!debouncer) {
        throw new Error("Slack debouncer was not created");
      }
      await handler(first, { source: "message" });
      expect(prepare).not.toHaveBeenCalled();
      handlingTable = handler(table, { source: "message" });
      await setImmediate();
      expect(debouncer.flushKey).toHaveBeenCalledWith("slack:default:C111:1709000000.000100:U111");
      const prepared = await started.promise;
      // Drain runnable work without advancing the debounce timer or releasing admission.
      await setImmediate();
      expect(vi.mocked(debouncer.enqueue).mock.calls.map(([entry]) => entry.message)).toEqual([
        first,
      ]);
      expect(prepare.mock.calls.map(([params]) => params.message)).toEqual([first]);
      expect(completed).toBe(false);
      if (admission === "adopted") {
        await prepared.turnAdoptionLifecycle?.onAdopted();
      } else {
        const onDeferred = prepared.turnAdoptionLifecycle?.onDeferred;
        if (!onDeferred) {
          throw new Error("Expected Slack deferral lifecycle");
        }
        expect(onDeferred()).not.toBe(false);
      }
      await setImmediate();
      expect(prepare.mock.calls.map(([params]) => params.message)).toEqual([first, table]);
      expect(completed).toBe(false);
      await handlingTable;
      complete.resolve();
      await debouncer.drain();
      expect(completed).toBe(true);
    } finally {
      complete.resolve();
      abort.abort();
      debouncer?.cancelKey("slack:default:C111:1709000000.000100:U111");
      debouncer?.cancelKey("slack:default:C111:1709000000.000200:U111");
      await Promise.all([handlingTable, debouncer?.drain()]);
      capture.onCreate = undefined;
      prepare.mockReset();
      dispatch.mockReset();
      vi.restoreAllMocks();
      vi.useRealTimers();
      clearRuntimeConfigSnapshot();
    }
  },
);
