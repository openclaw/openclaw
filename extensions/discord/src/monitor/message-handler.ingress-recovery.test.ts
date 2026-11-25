import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import {
  preflightDiscordMessageMock as preflightMock,
  processDiscordMessageMock as processMessage,
} from "./message-handler.module-test-helpers.js";

installDiscordIngressTestRuntime();
import assert from "node:assert/strict";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "openclaw/plugin-sdk/channel-outbound";
import * as channelOutbound from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsyncGate as barrier } from "../../../test-support/async-gate.test-support.js";
import { RequestClient } from "../internal/rest.js";
import * as ingressRuntime from "./ingress.js";
import { discordChannelInfoCacheState } from "./message-channel-info-state.js";
import * as preflightRuntime from "./message-handler.preflight.js";
const createDiscordIngressMonitor = ingressRuntime.createDiscordIngressMonitor;
const realPreflight = preflightRuntime.preflightDiscordMessage;
import { createDiscordMessageHandler } from "./message-handler.js";
import { createDiscordMessage } from "./message-handler.preflight.test-helpers.js";
import type { DiscordMessagePreflightParams as PreflightParams } from "./message-handler.preflight.types.js";
import {
  createDiscordHandlerParams,
  createDiscordQueuePreflightContextForMessage as messageContext,
} from "./message-handler.test-helpers.js";

type DiscordQueue = NonNullable<Parameters<typeof createDiscordIngressMonitor>[0]["queue"]>;
type DiscordIngressPayload = Parameters<DiscordQueue["enqueue"]>[1];
const priorAttempts = DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1;

const payload = (id: string, receivedAt = 1): DiscordIngressPayload => ({
  version: 1,
  receivedAt,
  rawMessage: createDiscordMessage({
    id,
    channelId: "lane-a",
    content: "hello",
    author: { id: "user-1", username: "alice", bot: false },
  }).rawData,
});

function prepareQueuedContext() {
  preflightMock.mockImplementation((async (params: PreflightParams) => ({
    ...messageContext(params.data),
    abortSignal: params.abortSignal,
    turnAdoptionLifecycle: params.turnAdoptionLifecycle,
  })) as never);
}

async function withQueue(run: (queue: DiscordQueue) => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-discord-recovery-", applyEnv: false },
    ({ stateDir }) =>
      run(
        createChannelIngressQueueForTests<DiscordIngressPayload>({
          channelId: "discord",
          accountId: "default",
          stateDir,
        }),
      ),
  );
}

async function seedPendingFailure(queue: DiscordQueue, id: string, attempts = 1, guild = false) {
  const event = payload(id);
  if (guild) {
    Object.assign(event.rawMessage, { guild_id: "guild-1" });
  }
  await queue.enqueue(id, event, { laneKey: "channel:lane-a", receivedAt: 1 });
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const claim = await queue.claim(id, { ownerId: `seed-${attempt}` });
    assert(claim, `Expected ${id} to be claimable for seed attempt ${attempt}`);
    await queue.release(claim, {
      lastError: `prior genuine failure ${attempt}`,
      releasedAt: 10 + attempt,
    });
  }
  return retryFacts(queue, id);
}

async function retryFacts(queue: DiscordQueue, id: string) {
  const record = (await queue.listPending({ limit: "all" })).find((entry) => entry.id === id);
  assert(record, `Expected pending Discord ingress row ${id}`);
  const { attempts, lastAttemptAt, lastError } = record;
  return { attempts, lastAttemptAt, lastError };
}

async function expectRecovered(queue: DiscordQueue, id: string) {
  prepareQueuedContext();
  processMessage.mockReset().mockResolvedValue(undefined);
  const replacement = createHandler({ queue });
  try {
    await vi.waitFor(() => expectRecord(queue, id, { kind: "completed" }));
    expect(processMessage).toHaveBeenCalledTimes(1);
  } finally {
    await replacement.deactivate();
  }
}

async function expectRecord(queue: DiscordQueue, id: string, record: Record<string, unknown>) {
  await expect(queue.enqueue(id, {} as DiscordIngressPayload)).resolves.toMatchObject(record);
}

function createHandler(params: {
  queue: DiscordQueue;
  debounceMs?: number;
  beforeDispatch?: () => Promise<void>;
  afterDispatch?: () => void;
  handlerParams?: ReturnType<typeof createDiscordHandlerParams>;
  client?: Parameters<typeof createDiscordMessageHandler>[0]["client"];
}) {
  const handlerParams = params.handlerParams ?? createDiscordHandlerParams();
  handlerParams.cfg.messages = {
    ...handlerParams.cfg.messages,
    inbound: { debounceMs: params.debounceMs ?? 0 },
  };
  vi.spyOn(ingressRuntime, "createDiscordIngressMonitor").mockImplementation((monitorParams) =>
    createDiscordIngressMonitor({
      ...monitorParams,
      queue: params.queue,
      dispatch: async (event, lifecycle) => {
        await params.beforeDispatch?.();
        const result = await monitorParams.dispatch(event, lifecycle);
        params.afterDispatch?.();
        return result;
      },
    }),
  );
  return createDiscordMessageHandler({
    ...handlerParams,
    client: params.client ?? ({} as never),
  });
}

it.each(["dispatch", "buffer", "preflight", "queued", "returns", "throws"] as const)(
  "preserves retry facts and replays work cancelled at %s",
  async (phase) => {
    await withQueue(async (queue) => {
      const before = await seedPendingFailure(queue, "poison", priorAttempts);
      const gate = barrier();
      const queued = createDeferred<void>();
      let signal: AbortSignal | undefined;
      prepareQueuedContext();
      if (phase === "preflight") {
        preflightMock.mockImplementation(async () => {
          await gate.wait();
          return null;
        });
      }
      if (phase === "queued") {
        const createRunQueue = channelOutbound.createChannelRunQueue;
        vi.spyOn(channelOutbound, "createChannelRunQueue").mockImplementation((params) => ({
          ...createRunQueue(params),
          enqueue: () => queued.resolve(),
        }));
      }
      if (phase === "returns" || phase === "throws") {
        processMessage.mockImplementation(async (ctx: { abortSignal?: AbortSignal }) => {
          signal = ctx.abortSignal;
          await gate.wait();
          if (phase === "throws") {
            throw new Error("processing stopped after cancellation");
          }
        });
      }
      const handler = createHandler({
        queue,
        beforeDispatch: phase === "dispatch" ? gate.wait : undefined,
        debounceMs: phase === "buffer" ? 60_000 : 0,
        afterDispatch: phase === "buffer" ? () => queued.resolve() : undefined,
      });
      await (phase === "buffer" || phase === "queued" ? queued.promise : gate.entered);
      const stopping = handler.deactivate();
      if (phase === "returns" || phase === "throws") {
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      }
      gate.release();
      await stopping;
      expect(preflightMock).toHaveBeenCalledTimes(
        phase === "dispatch" || phase === "buffer" ? 0 : 1,
      );
      if (phase === "queued") {
        expect(processMessage).not.toHaveBeenCalled();
        vi.mocked(channelOutbound.createChannelRunQueue).mockRestore();
      }
      expect(await retryFacts(queue, "poison")).toEqual(before);
      await expectRecovered(queue, "poison");
    });
  },
);

describe("Discord durable ingress settlement", () => {
  it("serves a live native mention before the remaining ambient recovery backlog", async () => {
    await withQueue(async (queue) => {
      const gate = barrier();
      const processed = createDeferred<void>();
      const preflights: string[] = [];
      const handlerParams = createDiscordHandlerParams();
      handlerParams.discordConfig = { ...handlerParams.discordConfig, groupPolicy: "open" };
      handlerParams.cfg.channels = { discord: handlerParams.discordConfig };
      handlerParams.guildEntries = { "guild-1": { requireMention: true } };
      handlerParams.historyLimit = 10;
      const old = Date.now() - 30 * 60_000;
      for (const id of ["1000", "1001", "1002"]) {
        const event = payload(id, old);
        Object.assign(event.rawMessage, {
          guild_id: "guild-1",
          timestamp: new Date(old).toISOString(),
        });
        await queue.enqueue(id, event, { laneKey: "channel:lane-a", receivedAt: old });
      }
      preflightMock.mockImplementation(async (params: PreflightParams) => {
        preflights.push(params.data.message.id);
        return realPreflight(params);
      });
      processMessage.mockImplementation(async (ctx) => {
        await ctx.turnAdoptionLifecycle.onAdopted();
        processed.resolve();
      });
      const handler = createHandler({
        queue,
        handlerParams,
        client: {
          fetchChannel: async () => {
            await gate.wait();
            return { id: "lane-a", type: 0, name: "general" };
          },
          fetchGuild: async () => ({ id: "guild-1", name: "Synthetic Guild" }),
        } as never,
      });
      try {
        await gate.entered;
        const live = payload("2000").rawMessage;
        Object.assign(live, {
          guild_id: "guild-1",
          content: "<@bot-123> please help",
          mentions: [{ ...live.author, id: "bot-123", bot: true }],
        });
        await handler(live, {} as never);
        expect(preflights).toEqual(["1000"]);
        gate.release();
        await processed.promise;
        expect(preflights.slice(0, 2)).toEqual(["1000", "2000"]);
        await vi.waitFor(() => expectRecord(queue, "1002", { kind: "completed" }));
        expect(processMessage).toHaveBeenCalledTimes(1);
        expect(handlerParams.guildHistories.get("lane-a")?.map((entry) => entry.messageId)).toEqual(
          ["1000", "1001", "1002"],
        );
      } finally {
        gate.release();
        await handler.deactivate();
      }
    });
  });

  it.each(["preflight", "processing"] as const)(
    "adopts a retry while the timed-out %s is still blocked",
    async (phase) => {
      vi.useFakeTimers();
      await withQueue(async (queue) => {
        const gate = barrier();
        prepareQueuedContext();
        const stalled = phase === "preflight" ? preflightMock : processMessage;
        const dispatch = stalled.getMockImplementation();
        let attempts = 0;
        stalled.mockImplementation(async (...args) => {
          if (++attempts === 1) {
            await gate.wait();
          }
          return dispatch?.(...args);
        });
        const handler = createHandler({ queue, debounceMs: 1 });
        try {
          await handler(payload("retry").rawMessage, {} as never);
          await vi.waitFor(() => expect(attempts).toBe(1));
          await vi.advanceTimersByTimeAsync(301_100);
          await vi.waitFor(() => expect(attempts).toBe(2));
          await expectRecord(queue, "retry", { kind: "completed" });
        } finally {
          gate.release();
          await handler.deactivate();
        }
      });
    },
  );

  it("waits for an active durable admission before stopping the drain", async () => {
    const admissionGate = createDeferred<void>();
    const stop = vi.fn(async () => {});
    vi.spyOn(ingressRuntime, "createDiscordIngressMonitor").mockImplementation(() => ({
      accept: () => admissionGate.promise,
      start: () => {},
      stop,
    }));
    const handler = createDiscordMessageHandler({
      ...createDiscordHandlerParams(),
      client: {} as never,
    });
    const handling = handler({ id: "m-admitting", channel_id: "ch-1" } as never, {} as never);

    const deactivation = handler.deactivate();
    await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();

    admissionGate.resolve();
    await Promise.all([handling, deactivation]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    "preflight",
    "authentication",
    "disabled-dm",
    "excluded",
    "revoked",
    "tool-only",
  ] as const)(
    "authorizes a dead-letter notice through current Discord policy: %s",
    async (phase) => {
      vi.useFakeTimers();
      await withQueue(async (queue) => {
        await seedPendingFailure(queue, "poison", priorAttempts, phase !== "disabled-dm");
        await queue.enqueue("follower", payload("follower", 2), {
          laneKey: "channel:lane-a",
          receivedAt: 2,
        });
        const failure = Object.assign(new Error("deterministic queued failure"), {
          status: phase === "authentication" ? 401 : 500,
        });
        const handlerParams = {
          ...createDiscordHandlerParams(),
          discordConfig: { groupPolicy: "open" as const },
          dmPolicy: "open" as const,
          dmEnabled: phase !== "disabled-dm",
          guildEntries: {
            [phase === "excluded" ? "excluded-guild" : "guild-1"]: { requireMention: false },
          },
        };
        handlerParams.cfg.messages = {
          visibleReplies: phase === "tool-only" ? "message_tool" : "automatic",
        };
        setRuntimeConfigSnapshot(handlerParams.cfg, handlerParams.cfg);
        preflightMock.mockImplementation(async (params: PreflightParams) => {
          if (!params.turnAdoptionLifecycle) {
            return realPreflight(params);
          }
          if (params.data.message.id === "poison") {
            throw failure;
          }
          return messageContext(params.data);
        });
        const post = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
          await expectRecord(queue, "poison", { kind: "failed" });
          return Response.json({});
        });
        let requests = 0;
        const handler = createHandler({
          queue,
          handlerParams,
          client: {
            rest: new RequestClient("synthetic-token", {
              fetch: async (...args) => {
                if (phase === "revoked" && ++requests === 1) {
                  const revoked = { channels: { discord: { groupPolicy: "disabled" as const } } };
                  setRuntimeConfigSnapshot(revoked, revoked);
                  return Response.json({ retry_after: 0.001 }, { status: 429 });
                }
                return post(...args);
              },
            }),
            fetchGuild: async () => null,
            fetchChannel: async () => ({ id: "lane-a", type: phase === "disabled-dm" ? 1 : 0 }),
          } as never,
        });
        try {
          await vi.advanceTimersByTimeAsync(1_000);
          await vi.waitFor(() => expectRecord(queue, "follower", { kind: "completed" }));
          await expectRecord(queue, "poison", {
            kind: "failed",
            record: {
              reason: phase === "authentication" ? "authentication-failed" : "retry-limit-exceeded",
            },
          });
          const noticeAllowed = ["preflight", "authentication"].includes(phase);
          expect(post).toHaveBeenCalledTimes(noticeAllowed ? 1 : 0);
          if (noticeAllowed) {
            expect(post.mock.calls[0]?.[0]).toContain("/channels/lane-a/messages");
            const body = post.mock.calls[0]?.[1]?.body;
            assert(typeof body === "string");
            expect(JSON.parse(body)).toEqual({
              content: expect.stringContaining("Please try again"),
              message_reference: { message_id: "poison", fail_if_not_exists: false },
              allowed_mentions: { parse: [], replied_user: false },
            });
          }
        } finally {
          await handler.deactivate();
        }
      });
    },
  );
});

afterEach(() => {
  discordChannelInfoCacheState.entries.clear();
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
