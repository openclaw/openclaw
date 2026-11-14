import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { WebClient } from "@slack/web-api";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { PLUGIN_COMMAND_DISPATCH } from "openclaw/plugin-sdk/plugin-command-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  getSessionEntry,
  normalizeSessionDeliveryState,
  prepareSessionEntryPatch as prepareStoredSessionEntryPatch,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  observeHostDataSql,
  useSessionStoreTempDirs,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackListenerWriteClient } from "../../client.js";
import { appendSlackStream, markSlackStreamsStopped, startSlackStream } from "../../streaming.js";
import { registerSlackWorkspaceEvents } from "../events.js";
import * as sessionEventRouting from "../message-handler/prepare-routing.js";
import { deliverSlackSlashReplies } from "../replies.js";
import { getSlackSessionRuns, registerSlackSessionRun } from "../session-run-targets.js";
import { getSlackSlashMocks, resetSlackSlashMocks } from "../slash.test-harness.js";
import { createSlackSystemEventTestHarness } from "./system-event-test-harness.js";

const { prepareSessionEntryPatch } = vi.hoisted(() => ({
  prepareSessionEntryPatch: vi.fn<PluginRuntime["agent"]["session"]["prepareSessionEntryPatch"]>(),
}));

vi.mock("../../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime.js")>();
  return {
    ...actual,
    getSlackRuntime: () => {
      const runtime = actual.getSlackRuntime();
      return {
        ...runtime,
        agent: {
          ...runtime.agent,
          session: { ...runtime.agent.session, prepareSessionEntryPatch },
        },
      };
    },
  };
});

vi.mock("../../streaming.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../streaming.js")>();
  return { ...actual, markSlackStreamsStopped: vi.fn(actual.markSlackStreamsStopped) };
});

const slashMocks = getSlackSlashMocks();

let tempDir: string;
const sessionDirs = useSessionStoreTempDirs(afterAll, "slack-session-events-");

const threadTs = "1712345678.000001";
function sessionEvent(type: string, overrides: Record<string, unknown> = {}) {
  return {
    type,
    channel: "D123",
    thread_ts: threadTs,
    user: "U123",
    event_ts: "1712345679.000001",
    streaming_message_ts: [],
    ...overrides,
  };
}

function slackDelivery(to: string, threadId?: string) {
  return normalizeSessionDeliveryState({
    context: { channel: "slack", accountId: "default", to, threadId },
  });
}

function createSessionEventHarness(channelType: "im" | "channel" | "mpim" = "im") {
  const harness = createSlackSystemEventTestHarness({ channelType, allowFrom: ["*"] });
  const client = new WebClient("xoxb-synthetic");
  const postMessage = vi.spyOn(client.chat, "postMessage").mockResolvedValue({
    ok: true,
    ts: "1712345679.000001",
  });
  const postEphemeral = vi.spyOn(client.chat, "postEphemeral").mockResolvedValue({ ok: true });
  const readThread = vi.spyOn(client.conversations, "replies").mockResolvedValue({
    ok: true,
    messages: [],
  });
  const setSlackSessionStatus = vi.fn(async () => true);
  const recordSlackSessionTitle = vi.fn();
  const storePath = path.join(tempDir, "sessions.sqlite");
  Object.assign(harness.ctx, {
    cfg: { session: { store: storePath } },
    accountId: "default",
    threadInheritParent: false,
    threadHistoryScope: "thread",
    useAccessGroups: false,
    textLimit: 4000,
    runtime: { error: vi.fn() },
    setSlackSessionStatus,
    recordSlackSessionTitle,
    getSlackAssistantThreadContext: () => undefined,
    isSlackAgentView: async () => true,
    isSlackManagedViewThread: async () => false,
  });
  Object.assign(harness.ctx.app, { client });
  setRuntimeConfigSnapshot(harness.ctx.cfg);
  registerSlackWorkspaceEvents({ ctx: harness.ctx });
  return {
    ...harness,
    storePath,
    emit: (type: string, event: Record<string, unknown> = {}) =>
      harness.getHandler(type)?.({ event: sessionEvent(type, event), body: {} }),
    route: (id = "G123", kind: "group" | "direct" = "group") =>
      resolveAgentRoute({
        cfg: harness.ctx.cfg,
        channel: "slack",
        accountId: "default",
        peer: { kind, id },
      }),
    stored: (sessionKey: string) => getSessionEntry({ agentId: "main", sessionKey, storePath }),
    recordSession: async (params: {
      sessionKey: string;
      peerId: string;
      threadId?: string;
      sessionId?: string;
      updatedAt?: number;
    }) => {
      await upsertSessionEntry({
        agentId: "main",
        storePath,
        sessionKey: params.sessionKey,
        entry: {
          sessionId: params.sessionId ?? params.sessionKey,
          updatedAt: params.updatedAt ?? Date.now(),
          chatType: channelType === "im" ? "direct" : channelType === "mpim" ? "group" : "channel",
          delivery: slackDelivery(params.peerId, params.threadId),
        },
      });
    },
    postMessage,
    postEphemeral,
    readThread,
    setSlackSessionStatus,
    recordSlackSessionTitle,
  };
}

function expectSessionOwner(type: string, sessionKey: string, last = false) {
  const mock =
    type === "agent_session_stopped" ? slashMocks.dispatchMock : prepareSessionEntryPatch;
  const expected = expect.objectContaining(
    type === "agent_session_stopped"
      ? { ctx: expect.objectContaining({ CommandTargetSessionKey: sessionKey }) }
      : { sessionKey },
  );
  if (last) {
    expect(mock).toHaveBeenLastCalledWith(expected);
  } else {
    expect(mock).toHaveBeenCalledWith(expected);
  }
}

function expectNoSessionMutation(harness: ReturnType<typeof createSessionEventHarness>) {
  expect(slashMocks.dispatchMock).not.toHaveBeenCalled();
  expect(prepareSessionEntryPatch).not.toHaveBeenCalled();
  expect(harness.recordSlackSessionTitle).not.toHaveBeenCalled();
  expect(markSlackStreamsStopped).not.toHaveBeenCalled();
  expect(harness.setSlackSessionStatus).not.toHaveBeenCalled();
}

describe("Slack agent lifecycle events", () => {
  beforeEach(() => {
    tempDir = sessionDirs.make();
    vi.clearAllMocks();
    clearRuntimeConfigSnapshot();
    resetSlackSlashMocks();
    prepareSessionEntryPatch.mockImplementation(prepareStoredSessionEntryPatch);
    slashMocks.deliverSlackSlashRepliesMock.mockImplementation(async (params: unknown) => {
      await deliverSlackSlashReplies(params as Parameters<typeof deliverSlackSlashReplies>[0]);
    });
  });

  it.each([false, true])(
    "records Agent View only for matching workspaces (dropped=%s)",
    async (dropped) => {
      const trackEvent = vi.fn();
      const harness = createSlackSystemEventTestHarness();
      harness.ctx.cfg = {};
      const recordSlackAgentView = vi.fn(async () => undefined);
      harness.ctx.recordSlackAgentView = recordSlackAgentView;
      if (dropped) {
        harness.ctx.shouldDropMismatchedSlackEvent = () => true;
      }
      registerSlackWorkspaceEvents({ ctx: harness.ctx, trackEvent });

      await harness.getHandler("app_context_changed")?.({
        event: { type: "app_context_changed", user: "U123", context: { entities: [] } },
        body: {},
      });

      expect(trackEvent).toHaveBeenCalledTimes(dropped ? 0 : 1);
      expect(recordSlackAgentView).toHaveBeenCalledTimes(dropped ? 0 : 1);
    },
  );

  it.each([
    {
      channelType: "im" as const,
      channel: "D123",
      sessionKey: "agent:main:main",
    },
    {
      channelType: "channel" as const,
      channel: "C123",
      sessionKey: "agent:main:slack:channel:c123:thread:1712345678.000001",
    },
  ])(
    "dispatches native Stop to the owning $channelType thread and replies there",
    async ({ channelType, channel, sessionKey }) => {
      const harness = createSessionEventHarness(channelType);
      harness.ctx.isSlackAgentView = async () => false;
      await harness.recordSession({
        sessionKey,
        peerId: channelType === "im" ? "U123" : channel,
        threadId: channelType !== "im" ? threadTs : undefined,
      });
      slashMocks.dispatchMock.mockImplementation(
        async (params: {
          dispatcherOptions: {
            deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<unknown>;
          };
        }) => {
          await params.dispatcherOptions.deliver({ text: "Stopped." }, { kind: "final" });
          return { counts: { final: 1, tool: 0, block: 0 } };
        },
      );

      await harness.emit("agent_session_stopped", {
        channel,
        streaming_message_ts: ["1712345678.000002"],
      });

      expect(harness.ctx.runtime.error).not.toHaveBeenCalled();
      expect(slashMocks.dispatchMock).toHaveBeenCalledOnce();
      expect(slashMocks.dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          ctx: expect.objectContaining({
            CommandBody: "/stop",
            CommandSource: "native",
            CommandAuthorized: true,
            CommandTargetSessionKey: sessionKey,
            SenderId: "U123",
            MessageThreadId: "1712345678.000001",
          }),
          replyOptions: expect.objectContaining({
            [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" },
          }),
        }),
      );
      expect(markSlackStreamsStopped).toHaveBeenCalledExactlyOnceWith(
        harness.ctx.app.client,
        channel,
        ["1712345678.000002"],
      );
      const dispatchOrder = expectDefined(
        slashMocks.dispatchMock.mock.invocationCallOrder[0],
        "stop command dispatch",
      );
      expect(vi.mocked(markSlackStreamsStopped).mock.invocationCallOrder[0]).toBeLessThan(
        dispatchOrder,
      );
      expect(harness.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel, thread_ts: "1712345678.000001", text: "Stopped." }),
      );
      expect(harness.setSlackSessionStatus).toHaveBeenCalledWith({
        channelId: channel,
        threadTs: "1712345678.000001",
        status: "active",
        eventScope: undefined,
      });
      const replyOrder = expectDefined(
        harness.postMessage.mock.invocationCallOrder[0],
        "stop command reply",
      );
      expect(harness.setSlackSessionStatus.mock.invocationCallOrder[0]).toBeGreaterThan(replyOrder);
      expect(harness.ctx.runtime.error).not.toHaveBeenCalled();
    },
  );

  it.each(["im", "channel"] as const)(
    "keeps streams deliverable after a denied %s Stop",
    async (channelType) => {
      const harness = createSessionEventHarness(channelType);
      const channel = channelType === "im" ? "D123" : "C123";
      harness.ctx.dmPolicy = "allowlist";
      harness.ctx.allowFrom = ["U_OWNER"];
      harness.ctx.useAccessGroups = true;
      const client = harness.ctx.app.client;
      const writeClient = expectDefined(
        getSlackListenerWriteClient({ listenerClient: client }),
        "derived Slack listener write client",
      );
      vi.spyOn(writeClient.chat, "startStream").mockResolvedValue({
        ok: true,
        ts: "1712345678.000002",
      });
      const appendError = new Error("Slack rejected the append");
      vi.spyOn(writeClient.chat, "appendStream").mockRejectedValue(appendError);
      const session = await startSlackStream({
        client,
        channel,
        threadTs: "1712345678.000001",
        text: "Visible reply",
        chunks: [],
      });

      await harness.emit("agent_session_stopped", {
        channel,
        user: "U_OTHER",
        streaming_message_ts: ["1712345678.000002"],
      });

      expect(slashMocks.dispatchMock).not.toHaveBeenCalled();
      expect(harness.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          user: "U_OTHER",
          text: "You are not authorized to use this command.",
          thread_ts: "1712345678.000001",
        }),
      );
      expect(session.stopped).toBe(false);
      expect(markSlackStreamsStopped).not.toHaveBeenCalled();
      // A server-side halt must surface to normal fallback delivery, not discard the tail.
      await expect(
        appendSlackStream({ session, text: "Remaining reply", chunks: [] }),
      ).rejects.toBe(appendError);
      expect(session.pendingText).toBe("Remaining reply");
    },
  );

  it.each(["agent_session_stopped", "agent_session_title_changed"])(
    "reads a recorded Assistant thread owner after restart for %s",
    async (type) => {
      const harness = createSessionEventHarness();
      harness.ctx.isSlackAgentView = async () => false;
      await harness.recordSession({
        sessionKey: "agent:main:main:thread:1712345678.000001",
        peerId: "U123",
        threadId: "1712345678.000001",
      });
      harness.readThread.mockResolvedValue({
        ok: true,
        messages: [{ metadata: { event_type: "assistant_thread_context", event_payload: {} } }],
      });
      await harness.emit(type, { title: "Assistant session" });
      const sessionKey = "agent:main:main:thread:1712345678.000001";
      expectSessionOwner(type, sessionKey);
    },
  );

  it("reports a failed thread lookup without stopping another DM session or clearing its status", async () => {
    const harness = createSessionEventHarness();
    harness.ctx.isSlackAgentView = async () => false;
    harness.readThread.mockRejectedValue(new Error("Slack temporarily unavailable"));
    await harness.emit("agent_session_stopped");
    expect(slashMocks.dispatchMock).not.toHaveBeenCalled();
    expect(markSlackStreamsStopped).not.toHaveBeenCalled();
    expect(harness.setSlackSessionStatus).not.toHaveBeenCalled();
    expect(harness.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Sorry, something went wrong handling that command." }),
    );
  });

  it.each(["agent_session_stopped", "agent_session_title_changed"])(
    "keeps the MPIM thread owner after a later top-level root for %s",
    async (type) => {
      const harness = createSessionEventHarness("mpim");
      const event = sessionEvent(type, { channel: "G123", title: "Group session" });
      const rootSessionKey = "agent:main:slack:group:g123";
      const now = Date.now();
      for (const [index, sessionKey] of [
        rootSessionKey,
        `${rootSessionKey}:thread:1712345678.000001`,
      ].entries()) {
        await harness.recordSession({
          sessionKey,
          peerId: "G123",
          threadId: threadTs,
          updatedAt: now + index * 1000,
        });
        if (index === 1) {
          await harness.recordSession({
            sessionKey: rootSessionKey,
            peerId: "G123",
            threadId: "1712345680.000001",
            updatedAt: now + 2000,
          });
        }
        await harness.getHandler(type)?.({ event, body: {} });
        expectSessionOwner(type, sessionKey, true);
      }
      expect(harness.ctx.runtime.error).not.toHaveBeenCalled();
    },
  );

  it.each(
    [false, true].flatMap((assistant) =>
      ["agent_session_stopped", "agent_session_title_changed"].map((type) => ({ assistant, type })),
    ),
  )(
    "does not mutate a missing managed owner for $type (Assistant: $assistant)",
    async ({ assistant, type }) => {
      const harness = createSessionEventHarness();
      await harness.recordSession({ sessionKey: "agent:main:main", peerId: "U123" });
      harness.ctx.isSlackAgentView = async () => !assistant;
      if (assistant) {
        // Slack excludes a message equal to oldest unless the request is inclusive.
        harness.readThread.mockImplementation(async ({ oldest, inclusive }) => ({
          ok: true,
          messages:
            !oldest || Number(threadTs) > Number(oldest) || (oldest === threadTs && inclusive)
              ? [
                  {
                    ts: threadTs,
                    metadata: { event_type: "assistant_thread_context", event_payload: {} },
                  },
                ]
              : [],
        }));
      }
      await harness.emit(type, { title: "Assistant title must not rename the ordinary DM" });
      expectNoSessionMutation(harness);
      if (type === "agent_session_stopped") {
        expect(harness.postEphemeral).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Sorry, something went wrong handling that command." }),
        );
      } else {
        expect(harness.ctx.runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("No recorded session owns this Slack conversation"),
        );
      }
    },
  );

  it("does not apply a title after another session wins the recorded conversation", async () => {
    const harness = createSessionEventHarness("mpim");
    const sessionKey = "agent:main:slack:group:g123";
    const competitor = `${sessionKey}:thread:${threadTs}`;
    const updatedAt = Date.now();
    await harness.recordSession({ sessionKey, peerId: "G123", threadId: threadTs, updatedAt });
    let hostQueries: string[] | undefined;
    prepareSessionEntryPatch.mockImplementationOnce(async (params) => {
      // Routing captured its real source; only the competing row changes before the writer.
      await harness.recordSession({
        sessionKey: competitor,
        peerId: "G123",
        threadId: threadTs,
        updatedAt: updatedAt + 1000,
      });
      const observed = observeHostDataSql();
      try {
        return await prepareStoredSessionEntryPatch(params);
      } finally {
        hostQueries = [...observed.queries];
        observed.restore();
      }
    });
    await harness.emit("agent_session_title_changed", {
      channel: "G123",
      title: "Title for the previous conversation owner",
    });
    expect(harness.ctx.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Slack conversation owner changed before the title update"),
    );
    expect(harness.stored(sessionKey)).not.toHaveProperty("displayName");
    expect(harness.stored(competitor)).not.toHaveProperty("displayName");
    expect(harness.recordSlackSessionTitle).not.toHaveBeenCalled();
    expect(hostQueries).toEqual([]);
  });

  it.each(["moved", "reset", "live"] as const)(
    "revalidates a title owner after waiting for a %s session writer",
    async (change) => {
      const harness = createSessionEventHarness("mpim");
      const sessionKey = "agent:main:slack:group:g123";
      await harness.recordSession({
        sessionKey,
        peerId: "G123",
        threadId: change === "live" ? undefined : threadTs,
      });
      const releaseRun =
        change === "live"
          ? registerSlackSessionRun(
              harness.ctx,
              { channelId: "G123", threadTs },
              {
                ...harness.route(),
                sessionKey,
              },
            )
          : undefined;
      const moving = createDeferred<void>();
      const releaseMove = createDeferred<void>();
      const titleQueued = createDeferred<void>();
      const move = prepareStoredSessionEntryPatch({
        agentId: "main",
        sessionKey,
        storePath: harness.storePath,
        prepare: async () => {
          moving.resolve();
          await releaseMove.promise;
          return {
            ...(change === "reset" ? { sessionId: "reset-session" } : {}),
            delivery: slackDelivery("G123", change === "reset" ? threadTs : "1712345680.000001"),
          };
        },
      });
      await moving.promise;
      prepareSessionEntryPatch.mockImplementation((params) => {
        titleQueued.resolve();
        return prepareStoredSessionEntryPatch(params);
      });
      const rename = harness.emit("agent_session_title_changed", {
        channel: "G123",
        title: "Late title for the first root",
      });
      await titleQueued.promise;
      releaseMove.resolve();
      await Promise.all([move, rename]);
      releaseRun?.();
      const stored = harness.stored(sessionKey);
      if (change === "moved") {
        expect(stored).not.toHaveProperty("displayName");
        expect(harness.recordSlackSessionTitle).not.toHaveBeenCalled();
      } else {
        expect(stored).toMatchObject({ displayName: "Late title for the first root" });
        expect(harness.recordSlackSessionTitle).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    { phase: "admission", change: "moved", source: "recorded" },
    { phase: "dispatch", change: "moved", source: "recorded" },
    { phase: "dispatch", change: "reset", source: "recorded" },
    { phase: "dispatch", change: "reset", source: "live" },
    { phase: "dispatch", change: "created", source: "live" },
    { phase: "dispatch", change: "rotated", source: "live" },
  ] as const)(
    "rejects a $change $source Stop owner at $phase",
    async ({ phase, change, source }) => {
      const harness = createSessionEventHarness("mpim");
      const sessionKey = "agent:main:slack:group:g123";
      const nextThreadTs = change !== "moved" ? threadTs : "1712345680.000001";
      let currentAfterDispatch: boolean | undefined;
      if (change !== "created") {
        await harness.recordSession({ sessionKey, peerId: "G123", threadId: threadTs });
      }
      const route = harness.route();
      const releaseRun =
        source === "live"
          ? registerSlackSessionRun(
              harness.ctx,
              { channelId: "G123", threadTs },
              { ...route, sessionKey },
            )
          : undefined;
      const moving = createDeferred<void>();
      const releaseMove = createDeferred<void>();
      const move = prepareStoredSessionEntryPatch({
        agentId: "main",
        sessionKey,
        storePath: harness.storePath,
        ...(change === "created"
          ? { fallbackEntry: { sessionId: "created-session", updatedAt: Date.now() } }
          : {}),
        prepare: async () => {
          moving.resolve();
          await releaseMove.promise;
          return {
            ...(change === "reset" ? { sessionId: "reset-session" } : {}),
            ...(change === "rotated" ? { lifecycleRevision: "rotated-revision" } : {}),
            delivery: slackDelivery("G123", nextThreadTs),
          };
        },
      });
      await moving.promise;
      const resolveRouting = sessionEventRouting.resolveSlackSessionEventRoutingContext;
      const lookup = vi
        .spyOn(sessionEventRouting, "resolveSlackSessionEventRoutingContext")
        .mockImplementationOnce(async (params) => {
          const owner = await resolveRouting(params);
          if (phase === "admission") {
            releaseMove.resolve();
            await move;
          }
          return owner;
        });
      slashMocks.dispatchMock.mockImplementation(async (params) => {
        releaseMove.resolve();
        await move;
        currentAfterDispatch = await params.replyOptions?.isCommandTargetCurrent?.();
        throw new Error("The selected session changed before it could be stopped.");
      });
      try {
        await harness.emit("agent_session_stopped", { channel: "G123" });
        await move;
        expect(harness.stored(sessionKey)).toMatchObject({
          delivery: { context: { threadId: nextThreadTs } },
        });
        if (phase === "dispatch") {
          expect(currentAfterDispatch).toBe(false);
        }
        expect(slashMocks.dispatchMock).toHaveBeenCalledTimes(phase === "dispatch" ? 1 : 0);
        expect(markSlackStreamsStopped).toHaveBeenCalledTimes(phase === "dispatch" ? 1 : 0);
        expect(harness.setSlackSessionStatus).not.toHaveBeenCalled();
      } finally {
        releaseMove.resolve();
        await move;
        lookup.mockRestore();
        releaseRun?.();
      }
    },
  );

  it("renames the live first-mode root owner after agent rerouting", async () => {
    const harness = createSessionEventHarness("mpim");
    const storeTemplate = path.join(tempDir, "{agentId}", "sessions.sqlite");
    harness.ctx.cfg = { session: { store: storeTemplate } };
    const address = { channelId: "G123", threadTs: "1712345678.000001" };
    const route = harness.route(address.channelId);
    const storePath = resolveStorePath(storeTemplate, { agentId: route.agentId });
    await upsertSessionEntry({
      agentId: route.agentId,
      storePath,
      sessionKey: route.sessionKey,
      entry: {
        sessionId: "live-root",
        updatedAt: Date.now(),
        chatType: "group",
        delivery: slackDelivery(address.channelId),
      },
    });
    const runtimeContext = Object.create(harness.ctx);
    runtimeContext.cfg = { ...harness.ctx.cfg };
    const release = registerSlackSessionRun(runtimeContext, address, route);
    harness.ctx.cfg = {
      ...harness.ctx.cfg,
      agents: { entries: { main: {}, other: {} } },
      bindings: [{ agentId: "other", match: { channel: "slack", accountId: "default" } }],
    };
    setRuntimeConfigSnapshot(harness.ctx.cfg);
    try {
      await harness.emit("agent_session_title_changed", {
        channel: address.channelId,
        thread_ts: address.threadTs,
        title: "First root",
      });
      expect(harness.ctx.runtime.error).not.toHaveBeenCalled();
      expect(prepareSessionEntryPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: route.agentId,
          storePath,
          sessionKey: route.sessionKey,
        }),
      );
      expect(
        getSessionEntry({ agentId: route.agentId, storePath, sessionKey: route.sessionKey }),
      ).toMatchObject({ displayName: "First root" });
      const authority = prepareSessionEntryPatch.mock.calls.at(-1)?.[0].authority;
      expect(authority?.kind).toBe("source");
      if (authority?.kind === "source") {
        expect(authority.source.nativeSource).not.toBe(true);
      }
      expect(
        getSessionEntry({
          agentId: "other",
          storePath: resolveStorePath(storeTemplate, { agentId: "other" }),
          sessionKey: route.sessionKey,
        }),
      ).toBeUndefined();
    } finally {
      release();
    }
  });

  it.each([
    { state: "finished", phase: "before preparation" },
    { state: "replacement", phase: "before preparation" },
    { state: "recorded", phase: "before preparation" },
    { state: "finished", phase: "after preparation" },
    { state: "replacement", phase: "after preparation" },
  ] as const)(
    "revalidates a proven DM parent after its publisher is $state $phase",
    async ({ state, phase }) => {
      const harness = createSessionEventHarness();
      harness.ctx.isSlackAgentView = async () => false;
      const route = harness.route("U123", "direct");
      await harness.recordSession({ sessionKey: route.sessionKey, peerId: "U123" });
      const release = registerSlackSessionRun(harness.ctx, { channelId: "D123", threadTs }, route);
      let releaseReplacement: (() => void) | undefined;
      const finishPublisher = () => {
        release();
        if (state !== "finished") {
          releaseReplacement = registerSlackSessionRun(
            harness.ctx,
            { channelId: "D123", threadTs },
            { ...route, sessionKey: "replacement-session" },
          );
        }
      };
      prepareSessionEntryPatch.mockImplementation(async (params) => {
        if (phase === "after preparation") {
          return prepareStoredSessionEntryPatch({
            ...params,
            prepare: (entry, context) => {
              finishPublisher();
              return params.prepare(entry, context);
            },
          });
        }
        finishPublisher();
        if (state === "recorded") {
          await harness.recordSession({
            sessionKey: route.sessionKey,
            peerId: "U123",
            threadId: threadTs,
          });
        }
        return prepareStoredSessionEntryPatch(params);
      });
      await harness.emit("agent_session_title_changed", { title: "Finished DM" });
      releaseReplacement?.();
      const entry = harness.stored(route.sessionKey);
      if (state === "replacement") {
        expect(harness.ctx.runtime.error).toHaveBeenCalled();
        expect(entry).not.toHaveProperty("displayName");
        expect(harness.recordSlackSessionTitle).not.toHaveBeenCalled();
      } else {
        expect(harness.ctx.runtime.error).not.toHaveBeenCalled();
        expect(entry).toMatchObject({ displayName: "Finished DM" });
        expect(harness.recordSlackSessionTitle).toHaveBeenCalledOnce();
      }
    },
  );

  it("stops pending MPIM publishers with no stored entries before delivering confirmations", async () => {
    const harness = createSessionEventHarness("mpim");
    const address = { channelId: "G123", threadTs: "1712345678.000001" };
    const route = harness.route();
    const keys = [route.sessionKey, `${route.sessionKey}:thread:${address.threadTs}`];
    const releases = keys.map((sessionKey) =>
      registerSlackSessionRun(harness.ctx, address, { ...route, sessionKey }),
    );
    const other = { channelId: "G123", threadTs: "1712345000.000001" };
    const releaseOther = registerSlackSessionRun(harness.ctx, other, {
      ...route,
      sessionKey: "other-session",
    });
    const currentOwners: Array<boolean | undefined> = [];
    slashMocks.dispatchMock.mockImplementation(async (params) => {
      currentOwners.push(await params.replyOptions?.isCommandTargetCurrent?.());
      expect(harness.postMessage).not.toHaveBeenCalled();
      const index = keys.indexOf(params.ctx.CommandTargetSessionKey);
      expect(index).toBeGreaterThanOrEqual(0);
      releases[index]?.();
      await params.dispatcherOptions.deliver({ text: "Stopped." }, { kind: "final" });
      return { counts: { final: 1, tool: 0, block: 0 } };
    });
    await harness.emit("agent_session_stopped", {
      channel: address.channelId,
      thread_ts: address.threadTs,
    });
    expect(
      slashMocks.dispatchMock.mock.calls.map(([params]) => params.ctx.CommandTargetSessionKey),
    ).toEqual(keys);
    expect(currentOwners).toEqual([true, true]);
    expect(harness.stored(route.sessionKey)).toBeUndefined();
    expect(harness.postMessage).toHaveBeenCalledTimes(2);
    expect(getSlackSessionRuns(harness.ctx, address)).toEqual([]);
    expect(getSlackSessionRuns(harness.ctx, other)).toHaveLength(1);
    expect(harness.setSlackSessionStatus).toHaveBeenCalledOnce();
    releaseOther();
  });

  it.each(["agent_session_stopped", "agent_session_title_changed"])(
    "keeps Enterprise DM %s events on the workspace-scoped session",
    async (type) => {
      const harness = createSessionEventHarness();
      harness.ctx.installationIdentity = { kind: "enterprise", enterpriseId: "E_TEST" };
      await harness.recordSession({
        sessionKey: "agent:main:main:account:default:team:t_other",
        peerId: "team:T_OTHER:user:U123",
      });
      await harness.getHandler(type)?.({
        event: sessionEvent(type, { title: "Ordinary Enterprise DM" }),
        body: {},
        context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId: "T_OTHER" },
        client: harness.ctx.app.client,
      });
      const sessionKey = "agent:main:main:account:default:team:t_other";
      expectSessionOwner(type, sessionKey);
    },
  );

  it.each(["agent_session_stopped", "agent_session_title_changed"])(
    "drops mismatched workspace %s events before dispatch or patch",
    async (type) => {
      const harness = createSessionEventHarness();
      harness.ctx.shouldDropMismatchedSlackEvent = () => true;

      await harness.getHandler(type)?.({ event: { type }, body: {} });

      expectNoSessionMutation(harness);
    },
  );
});
