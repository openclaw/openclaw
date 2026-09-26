import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
// Discord tests cover durable retry recovery through full handler replacement.
import path from "node:path";
import type { APIMessage } from "discord-api-types/v10";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  createChannelIngressQueueForTests,
  observeChannelIngressQueueWrite,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import {
  type ChannelIngressQueue,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveIngressRetryDelayMs } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordIngressMonitor, type DiscordIngressLifecycle } from "./ingress.js";
import { createDiscordMessageHandler } from "./message-handler.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";
import {
  createDiscordHandlerParams,
  createDiscordQueuePreflightContextForMessage,
} from "./message-handler.test-helpers.js";
import { createDiscordMessageRunQueue } from "./message-run-queue.js";

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: APIMessage;
};

type DiscordQueue = ChannelIngressQueue<DiscordIngressPayload>;

function rawMessage(id: string, channelId = "lane-a", timestamp = 0): APIMessage {
  return {
    id,
    channel_id: channelId,
    content: "hello",
    author: {
      id: "user-1",
      username: "alice",
      discriminator: "0",
      avatar: null,
    },
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    timestamp: new Date(timestamp).toISOString(),
    edited_timestamp: null,
    components: [],
    pinned: false,
    type: 0,
    tts: false,
  } as unknown as APIMessage;
}

async function withQueue(
  run: (queue: DiscordQueue, stateDir: string) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-discord-recovery-", applyEnv: false },
    ({ stateDir }) =>
      run(
        createChannelIngressQueueForTests<DiscordIngressPayload>({
          channelId: "discord",
          accountId: "default",
          stateDir,
        }),
        stateDir,
      ),
  );
}

async function seedPendingFailure(params: {
  queue: DiscordQueue;
  id: string;
  attempts: number;
  laneKey?: string;
}): Promise<void> {
  await params.queue.enqueue(
    params.id,
    { version: 1, receivedAt: 1, rawMessage: rawMessage(params.id) },
    { laneKey: params.laneKey ?? "channel:lane-a", receivedAt: 1 },
  );
  for (let attempt = 1; attempt <= params.attempts; attempt += 1) {
    const claim = await params.queue.claim(params.id, { ownerId: `seed-${attempt}` });
    if (!claim) {
      throw new Error(`Expected ${params.id} to be claimable for seed attempt ${attempt}`);
    }
    await params.queue.release(claim, {
      lastError: `prior genuine failure ${attempt}`,
      releasedAt: 10 + attempt,
    });
  }
}

async function retryFacts(queue: DiscordQueue, id: string) {
  const record = (await queue.listPending({ limit: "all" })).find((entry) => entry.id === id);
  if (!record) {
    throw new Error(`Expected pending Discord ingress row ${id}`);
  }
  return {
    attempts: record.attempts,
    lastAttemptAt: record.lastAttemptAt,
    lastError: record.lastError,
  };
}

function createHandler(params: {
  queue: DiscordQueue;
  preflight: (input: { data: { message?: { id?: string } } }) => Promise<null>;
  debounceMs?: number;
  beforeDispatch?: () => Promise<void>;
}) {
  const handlerParams = createDiscordHandlerParams();
  handlerParams.cfg.messages = { inbound: { debounceMs: params.debounceMs ?? 0 } };
  return createDiscordMessageHandler({
    ...handlerParams,
    client: {} as never,
    testing: {
      preflightDiscordMessage: params.preflight as never,
      createIngressMonitor: (monitorParams) =>
        createDiscordIngressMonitor({
          ...monitorParams,
          queue: params.queue,
          dispatch: params.beforeDispatch
            ? async (event, lifecycle) => {
                await params.beforeDispatch?.();
                return await monitorParams.dispatch(event, lifecycle);
              }
            : monitorParams.dispatch,
        }),
    },
  });
}

describe("Discord durable ingress replacement recovery", () => {
  it("terminally settles a preexisting exhausted poison row before its follower", async () => {
    await withQueue(async (queue) => {
      await seedPendingFailure({
        queue,
        id: "poison",
        attempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
      });
      await queue.enqueue(
        "follower",
        { version: 1, receivedAt: 2, rawMessage: rawMessage("follower") },
        { laneKey: "channel:lane-a", receivedAt: 2 },
      );
      const dispatched: string[] = [];
      const followerCompleted = observeChannelIngressQueueWrite(queue, "complete", "follower");
      const handler = createHandler({
        queue,
        preflight: vi.fn(async ({ data }) => {
          const id = data.message?.id ?? "unknown";
          dispatched.push(id);
          if (id === "poison") {
            throw new Error("recovered poison failure");
          }
          return null;
        }),
      });
      try {
        await expect(followerCompleted).resolves.toBe(true);
        await expect(queue.enqueue("poison", {} as DiscordIngressPayload)).resolves.toMatchObject({
          kind: "failed",
          record: { reason: "retry-limit-exceeded" },
        });
        await expect(queue.enqueue("follower", {} as DiscordIngressPayload)).resolves.toMatchObject(
          {
            kind: "completed",
          },
        );
        expect(dispatched).toEqual(["poison", "follower"]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
      } finally {
        await handler.deactivate();
      }
    });
  });

  it("preserves retry facts across every Discord cancellation route and replacement", async () => {
    await withQueue(async (queue) => {
      await seedPendingFailure({
        queue,
        id: "poison",
        attempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1,
      });
      await queue.enqueue(
        "follower",
        { version: 1, receivedAt: 2, rawMessage: rawMessage("follower") },
        { laneKey: "channel:lane-a", receivedAt: 2 },
      );
      const expectedFacts = await retryFacts(queue, "poison");

      const dispatchEntered = createDeferred<void>();
      const releaseDispatch = createDeferred<void>();
      const beforeDispatch = async () => {
        dispatchEntered.resolve();
        await releaseDispatch.promise;
      };
      const beforeDispatchPreflight = vi.fn(async () => null);
      const beforeDispatchHandler = createHandler({
        queue,
        preflight: beforeDispatchPreflight,
        beforeDispatch,
      });
      await dispatchEntered.promise;
      const beforeDispatchStop = beforeDispatchHandler.deactivate();
      await Promise.resolve();
      releaseDispatch.resolve();
      await beforeDispatchStop;
      expect(beforeDispatchPreflight).not.toHaveBeenCalled();
      expect(await retryFacts(queue, "poison")).toEqual(expectedFacts);

      const bufferedPreflight = vi.fn(async () => null);
      const bufferedHandler = createHandler({
        queue,
        preflight: bufferedPreflight,
        debounceMs: 60_000,
      });
      // Both rows sit on `channel:lane-a`. Releasing the lane on defer lets the
      // second row be claimed and buffered by the same debounce window instead
      // of being guillotined behind the first, so the buffered handler holds two
      // claims, not one. Neither may reach preflight, and neither may lose its
      // retry facts on replacement — that is what this case guards.
      await vi.waitFor(async () => expect(await queue.listClaims()).toHaveLength(2));
      await bufferedHandler.deactivate();
      expect(bufferedPreflight).not.toHaveBeenCalled();
      expect(await retryFacts(queue, "poison")).toEqual(expectedFacts);

      const preflightEntered = createDeferred<void>();
      const releasePreflight = createDeferred<void>();
      const activePreflight = vi.fn(async () => {
        preflightEntered.resolve();
        await releasePreflight.promise;
        return null;
      });
      const activeHandler = createHandler({ queue, preflight: activePreflight });
      await preflightEntered.promise;
      const activeStop = activeHandler.deactivate();
      await Promise.resolve();
      releasePreflight.resolve();
      await activeStop;
      expect(activePreflight).toHaveBeenCalledTimes(1);
      expect(await retryFacts(queue, "poison")).toEqual(expectedFacts);

      const finalDispatches: string[] = [];
      const followerCompleted = observeChannelIngressQueueWrite(queue, "complete", "follower");
      const replacement = createHandler({
        queue,
        preflight: vi.fn(async ({ data }) => {
          const id = data.message?.id ?? "unknown";
          finalDispatches.push(id);
          if (id === "poison") {
            throw new Error("final genuine failure");
          }
          return null;
        }),
      });
      try {
        await expect(followerCompleted).resolves.toBe(true);
        await expect(queue.enqueue("poison", {} as DiscordIngressPayload)).resolves.toMatchObject({
          kind: "failed",
          record: { reason: "retry-limit-exceeded" },
        });
        await expect(queue.enqueue("follower", {} as DiscordIngressPayload)).resolves.toMatchObject(
          {
            kind: "completed",
          },
        );
        expect(finalDispatches).toEqual(["poison", "follower"]);
      } finally {
        await replacement.deactivate();
      }
    });
  });
});

describe("Discord durable ingress settlement", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("waits for an active durable admission before stopping the drain", async () => {
    const admissionGate = createDeferred<void>();
    const accept = vi.fn(() => admissionGate.promise);
    const start = vi.fn();
    const stop = vi.fn(async () => {});
    const params = createDiscordHandlerParams();
    const handler = createDiscordMessageHandler({
      ...params,
      client: {} as never,
      testing: {
        createIngressMonitor: vi.fn(() => ({ accept, start, stop })),
      },
    });
    const handling = handler({ id: "m-admitting", channel_id: "ch-1" } as never, {} as never);

    let deactivated = false;
    const deactivation = handler.deactivate().then(() => {
      deactivated = true;
    });
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(deactivated).toBe(false);

    admissionGate.resolve();
    await Promise.all([handling, deactivation]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("dead-letters an exhausted preflight failure and releases its Discord lane", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      await withQueue(async (queue) => {
        const attempted: string[] = [];
        const dispositions = Array.from({ length: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS }, () =>
          createDeferred<boolean>(),
        );
        const followerCompleted = observeChannelIngressQueueWrite(queue, "complete", "follower");
        void followerCompleted.catch(() => {});
        for (const disposition of dispositions) {
          void disposition.promise.catch(() => {});
        }
        let dispositionCount = 0;
        const observePoisonDisposition = (
          ref: Parameters<DiscordQueue["release"]>[0],
          promise: Promise<boolean>,
        ) => {
          if ((typeof ref === "string" ? ref : ref.id) === "poison") {
            const disposition = dispositions[dispositionCount++];
            if (disposition) {
              void promise.then(disposition.resolve, disposition.reject);
            }
          }
          return promise;
        };
        const observedQueue: DiscordQueue = {
          ...queue,
          release: (ref, options) => observePoisonDisposition(ref, queue.release(ref, options)),
          fail: (ref, options) => observePoisonDisposition(ref, queue.fail(ref, options)),
        };
        const preflight = vi.fn(async (params: { data: { message?: { id?: string } } }) => {
          const id = params.data.message?.id ?? "unknown";
          attempted.push(id);
          if (id === "poison") {
            throw new Error("deterministic preflight failure");
          }
          return null;
        });
        const params = createDiscordHandlerParams();
        const handler = createDiscordMessageHandler({
          ...params,
          client: {} as never,
          testing: {
            preflightDiscordMessage: preflight as never,
            createIngressMonitor: (monitorParams) =>
              createDiscordIngressMonitor({ ...monitorParams, queue: observedQueue }),
          },
        });
        try {
          // Frozen fake time stamps every admission with the same receipt instant, which
          // orders the lane by event id and puts "poison" behind "follower". Separate the
          // admissions so the poison event really is the lane head this case is about.
          await handler(rawMessage("poison", "lane-a", Date.now()) as never, {} as never);
          await vi.advanceTimersByTimeAsync(1);
          await handler(rawMessage("follower", "lane-a", Date.now()) as never, {} as never);
          await handler(rawMessage("independent", "lane-b", Date.now()) as never, {} as never);

          for (let attempt = 0; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
            await expect(dispositions[attempt]!.promise).resolves.toBe(true);
            if (attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1) {
              const pending = (await queue.listPending()).find((event) => event.id === "poison");
              expect(pending).toMatchObject({ attempts: attempt + 1 });
              const retryDelay = resolveIngressRetryDelayMs(pending!, undefined, Date.now());
              expect(retryDelay).toBeGreaterThan(0);
              vi.setSystemTime(Date.now() + retryDelay);
              await vi.advanceTimersByTimeAsync(1_000);
            }
          }

          await expect(followerCompleted).resolves.toBe(true);
          expect(attempted).toContain("follower");
          expect(attempted.indexOf("independent")).toBeGreaterThanOrEqual(0);
          expect(attempted.indexOf("independent")).toBeLessThan(attempted.indexOf("follower"));
          expect(attempted.filter((id) => id === "poison")).toHaveLength(
            DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
          );
          const settled = {} as DiscordIngressPayload;
          await expect(queue.enqueue("poison", settled)).resolves.toMatchObject({
            kind: "failed",
            record: { reason: "retry-limit-exceeded" },
          });
          await expect(queue.enqueue("follower", settled)).resolves.toMatchObject({
            kind: "completed",
          });
          const runtimeErrors = vi
            .mocked(params.runtime.error)
            .mock.calls.map(([message]) => String(message));
          expect(runtimeErrors.some((message) => message.includes("reached retry limit"))).toBe(
            true,
          );
          expect(runtimeErrors.join("\n")).not.toContain("hello");
        } finally {
          await handler.deactivate();
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("dead-letters an exhausted queued processing failure and releases its Discord lane", async () => {
    vi.useFakeTimers();
    try {
      await withQueue(async (queue) => {
        const receivedAt = 1;
        const ingressPayload = (id: string): DiscordIngressPayload => ({
          version: 1,
          receivedAt,
          rawMessage: rawMessage(id, "lane-a", Date.now()),
        });
        const poisonPayload = ingressPayload("processing-poison");
        const followerPayload = ingressPayload("processing-follower");
        const lane = { laneKey: "channel:lane-a" };
        await queue.enqueue("processing-poison", poisonPayload, { ...lane, receivedAt });
        await queue.enqueue("processing-follower", followerPayload, {
          ...lane,
          receivedAt: receivedAt + 1,
        });
        for (let attempt = 1; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
          const claim = await queue.claim("processing-poison", {
            ownerId: `seed-failure-${attempt}`,
          });
          if (!claim) {
            throw new Error(`failed to seed retry ${attempt}`);
          }
          await queue.release(claim, {
            lastError: `seed processing failure ${attempt}`,
            releasedAt: poisonPayload.receivedAt + attempt,
          });
        }
        const processed: string[] = [];
        const handler = createDiscordMessageHandler({
          ...createDiscordHandlerParams(),
          client: {} as never,
          testing: {
            preflightDiscordMessage: (async (preflightParams: DiscordMessagePreflightParams) => ({
              ...createDiscordQueuePreflightContextForMessage(preflightParams.data),
              turnAdoptionLifecycle: preflightParams.turnAdoptionLifecycle,
            })) as never,
            processDiscordMessage: async (ctx) => {
              processed.push(ctx.message.id);
              if (ctx.message.id === "processing-poison") {
                throw new Error("deterministic queued processing failure");
              }
            },
            createIngressMonitor: (monitorParams) =>
              createDiscordIngressMonitor({ ...monitorParams, queue }),
          },
        });
        try {
          await vi.advanceTimersByTimeAsync(1_000);
          await vi.waitFor(() => expect(processed).toHaveLength(2));
          expect(processed).toEqual(["processing-poison", "processing-follower"]);
          expect((await queue.listFailed?.())?.[0]?.reason).toBe("retry-limit-exceeded");
        } finally {
          await handler.deactivate();
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(
    (["replacement", "exhaustion"] as const).flatMap((outcome) =>
      (["acp", "ordinary"] as const).map((targetKind) => ({ outcome, targetKind })),
    ),
  )(
    "rebuilds a stale bound route from durable Discord ingress: $outcome ($targetKind)",
    async ({ outcome, targetKind }) => {
      const { buildChannelInboundEventContext } =
        await import("openclaw/plugin-sdk/channel-inbound");
      const { resolveRuntimeConversationBindingRouteAsync } =
        await import("openclaw/plugin-sdk/conversation-binding-runtime");
      const { registerSessionBindingAdapter, unregisterSessionBindingAdapter } =
        await import("openclaw/plugin-sdk/thread-bindings-session-runtime");
      const { dispatchReplyWithDispatcher } = await import("openclaw/plugin-sdk/reply-runtime");
      const { resolveAgentRoute } = await import("openclaw/plugin-sdk/routing");
      vi.useFakeTimers();
      try {
        await withQueue(async (queue, stateDir) => {
          const channelId = `binding-${outcome}-${targetKind}`;
          const messageId = `stale-route-${outcome}-${targetKind}`;
          const oldTarget =
            targetKind === "acp"
              ? "agent:main:acp:stale-discord-route"
              : "agent:main:ordinary-bound-route";
          const conversation = {
            channel: "discord",
            accountId: "default",
            conversationId: channelId,
          };
          let binding:
            | import("openclaw/plugin-sdk/conversation-binding-runtime").SessionBindingRecord
            | null = {
            bindingId: `binding-${outcome}`,
            targetSessionKey: oldTarget,
            targetKind: "session",
            status: "active",
            boundAt: 1,
            conversation,
          };
          const adapter: import("openclaw/plugin-sdk/thread-bindings-session-runtime").SessionBindingAdapter =
            {
              channel: "discord",
              accountId: "default",
              listBySession: (sessionKey) =>
                binding?.targetSessionKey === sessionKey ? [binding] : [],
              resolveByConversation: () => binding,
              inspectByConversationAsync: async () => binding,
              touchAsync: async () => {},
            };
          const params = createDiscordHandlerParams();
          registerSessionBindingAdapter(adapter);
          const cfg: OpenClawConfig = {
            ...params.cfg,
            agents: { defaults: { workspace: path.join(stateDir, "workspace") } },
            session: { store: path.join(stateDir, "sessions.json") },
            plugins: { enabled: false },
            messages: { inbound: { debounceMs: 0 }, visibleReplies: "automatic" },
          };
          const baseRoute = resolveAgentRoute({
            cfg,
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: channelId },
          });
          const contexts: Array<ReturnType<typeof buildChannelInboundEventContext>> = [];
          const rejected: unknown[] = [];
          const preflightMessages: Array<{ id: string; content: string }> = [];
          const effect = vi.fn(async (_ctx: { SessionKey?: string }) => ({
            text: "reply from rebuilt route",
          }));
          const deliver = vi.fn(async (_payload: { text?: string }) => {});
          const attempts = outcome === "replacement" ? 2 : DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS;
          const committedDispositions = Array.from({ length: attempts }, () =>
            createDeferred<void>(),
          );
          for (const disposition of committedDispositions) {
            void disposition.promise.catch(() => {});
          }
          const dispositionObservers: Promise<void>[] = [];
          let dispositionCount = 0;
          let dispositionError: Error | undefined;
          const rejectDisposition = (error: unknown) => {
            dispositionError ??=
              error instanceof Error
                ? error
                : new Error("Ingress disposition failed", { cause: error });
            for (const disposition of committedDispositions) {
              disposition.reject(dispositionError);
            }
          };
          const observeDisposition = (
            kind: "release" | "complete" | "fail",
            ref: Parameters<DiscordQueue["release"]>[0],
            promise: Promise<boolean>,
            recordAttempt = true,
          ) => {
            if ((typeof ref === "string" ? ref : ref.id) !== messageId) {
              return promise;
            }
            const index = dispositionCount++;
            const disposition = committedDispositions[index];
            const expectedKind =
              index < attempts - 1 ? "release" : outcome === "replacement" ? "complete" : "fail";
            dispositionObservers.push(
              promise.then((committed) => {
                if (!disposition || kind !== expectedKind || !committed || !recordAttempt) {
                  rejectDisposition(
                    new Error(
                      `Unexpected ingress disposition ${index + 1}: ${kind}, committed=${committed}, recordAttempt=${recordAttempt}`,
                    ),
                  );
                  return;
                }
                disposition.resolve();
              }, rejectDisposition),
            );
            return promise;
          };
          const release = queue.release.bind(queue);
          const releaseSpy = vi
            .spyOn(queue, "release")
            .mockImplementation((ref, options) =>
              observeDisposition(
                "release",
                ref,
                release(ref, options),
                options?.recordAttempt !== false,
              ),
            );
          const complete = queue.complete.bind(queue);
          const completeSpy = vi
            .spyOn(queue, "complete")
            .mockImplementation((ref, options) =>
              observeDisposition("complete", ref, complete(ref, options)),
            );
          const fail = queue.fail.bind(queue);
          const failSpy = vi
            .spyOn(queue, "fail")
            .mockImplementation((ref, options) =>
              observeDisposition("fail", ref, fail(ref, options)),
            );
          const handler = createDiscordMessageHandler({
            ...params,
            cfg,
            client: {} as never,
            testing: {
              preflightDiscordMessage: (async (input: DiscordMessagePreflightParams) => {
                preflightMessages.push({
                  id: input.data.message.id,
                  content: input.data.message.content,
                });
                const { route } = await resolveRuntimeConversationBindingRouteAsync({
                  route: baseRoute,
                  conversation,
                });
                return {
                  ...createDiscordQueuePreflightContextForMessage(input.data),
                  cfg,
                  route,
                  turnAdoptionLifecycle: input.turnAdoptionLifecycle,
                };
              }) as never,
              processDiscordMessage: async (ctx) => {
                const payload = buildChannelInboundEventContext({
                  channel: "discord",
                  accountId: "default",
                  messageId: ctx.message.id,
                  from: "discord:user:user-1",
                  sender: { id: "user-1" },
                  conversation: { kind: "channel", id: channelId },
                  route: { ...ctx.route, routeSessionKey: ctx.route.sessionKey },
                  reply: { to: `channel:${channelId}` },
                  message: { rawBody: ctx.message.content ?? "hello" },
                });
                contexts.push(payload);
                // The channel has captured its target before the binding owner changes.
                binding =
                  outcome === "replacement" || !binding
                    ? null
                    : { ...binding, boundAt: binding.boundAt + 1 };
                try {
                  await dispatchReplyWithDispatcher({
                    cfg,
                    ctx: payload,
                    dispatcherOptions: { deliver },
                    replyResolver: effect,
                  });
                } catch (error) {
                  expect(deliver).not.toHaveBeenCalled();
                  rejected.push(error);
                  throw error;
                }
              },
              createIngressMonitor: (monitorParams) =>
                createDiscordIngressMonitor({ ...monitorParams, queue }),
            },
          });
          try {
            await handler(rawMessage(messageId, channelId, Date.now()) as never, {} as never);
            for (let attempt = 0; attempt < attempts; attempt += 1) {
              // Admission starts detached dispatch; only a committed disposition permits retry time.
              await committedDispositions[attempt]!.promise;
              if (attempt < attempts - 1) {
                const pending = await queue.listPending();
                expect(pending).toHaveLength(1);
                expect(pending[0]).toMatchObject({ id: messageId, attempts: attempt + 1 });
                expect(await queue.listClaims()).toEqual([]);
                const retryDelay = resolveIngressRetryDelayMs(pending[0]!, undefined, Date.now());
                expect(retryDelay).toBeGreaterThan(0);
                await vi.advanceTimersByTimeAsync(retryDelay);
              }
            }
            await vi.waitFor(async () => {
              expect(await queue.listPending()).toEqual([]);
              expect(await queue.listClaims()).toEqual([]);
            });
            expect(preflightMessages).toEqual(
              Array.from({ length: attempts }, () => ({ id: messageId, content: "hello" })),
            );
            expect(contexts).toHaveLength(attempts);
            expect(contexts[0]?.SessionKey).toBe(oldTarget);
            expect(new Set(contexts).size).toBe(attempts);
            expect(rejected).toHaveLength(outcome === "replacement" ? 1 : attempts);
            for (const error of rejected) {
              expect(error).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
            }
            expect(effect.mock.calls.filter(([ctx]) => ctx.SessionKey === oldTarget)).toEqual([]);
            if (outcome === "replacement") {
              expect(contexts[1]?.SessionKey).toBe(baseRoute.sessionKey);
              expect(effect).toHaveBeenCalledOnce();
              expect(effect.mock.calls[0]?.[0].SessionKey).toBe(baseRoute.sessionKey);
              expect(deliver).toHaveBeenCalledOnce();
              expect(deliver.mock.calls[0]?.[0].text).toBe("reply from rebuilt route");
              await expect(
                queue.enqueue(messageId, {} as DiscordIngressPayload),
              ).resolves.toMatchObject({ kind: "completed" });
            } else {
              expect(effect).not.toHaveBeenCalled();
              expect(deliver).not.toHaveBeenCalled();
              await expect(
                queue.enqueue(messageId, {} as DiscordIngressPayload),
              ).resolves.toMatchObject({
                kind: "failed",
                record: { reason: "session-start-conflict-retry-limit" },
              });
            }
          } finally {
            try {
              await handler.deactivate();
            } finally {
              await Promise.all(dispositionObservers);
              releaseSpy.mockRestore();
              completeSpy.mockRestore();
              failSpy.mockRestore();
              unregisterSessionBindingAdapter({ ...conversation, adapter });
            }
          }
          expect(dispositionError).toBeUndefined();
          expect(dispositionCount).toBe(attempts);
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("preserves retry facts when deactivation cancels a durable Discord claim", async () => {
    await withQueue(async (queue) => {
      const raw = rawMessage("cancelled", "lane-a", Date.now());
      await queue.enqueue(
        "cancelled",
        { version: 1, receivedAt: 10, rawMessage: raw },
        { laneKey: "channel:lane-a", receivedAt: 10 },
      );
      const failedClaim = await queue.claim("cancelled", { ownerId: "failed-owner" });
      if (!failedClaim) {
        throw new Error("Expected the cancellation fixture claim");
      }
      await queue.release(failedClaim, {
        lastError: "previous genuine failure",
        releasedAt: 20,
      });
      const before = (await queue.listPending())[0];
      const firstPreflight = vi.fn(async () => null);
      const firstParams = createDiscordHandlerParams();
      firstParams.cfg.messages = { inbound: { debounceMs: 60_000 } };
      const first = createDiscordMessageHandler({
        ...firstParams,
        client: {} as never,
        testing: {
          preflightDiscordMessage: firstPreflight as never,
          createIngressMonitor: (monitorParams) =>
            createDiscordIngressMonitor({ ...monitorParams, queue }),
        },
      });

      await vi.waitFor(async () => expect(await queue.listClaims()).toHaveLength(1));
      await first.deactivate();

      expect(firstPreflight).not.toHaveBeenCalled();
      expect(await queue.listPending()).toEqual([
        expect.objectContaining({
          id: "cancelled",
          attempts: before?.attempts,
          lastAttemptAt: before?.lastAttemptAt,
          lastError: before?.lastError,
        }),
      ]);

      const replacementPreflight = vi.fn(async () => null);
      const replacementParams = createDiscordHandlerParams();
      const replacement = createDiscordMessageHandler({
        ...replacementParams,
        client: {} as never,
        testing: {
          preflightDiscordMessage: replacementPreflight as never,
          createIngressMonitor: (monitorParams) =>
            createDiscordIngressMonitor({ ...monitorParams, queue }),
        },
      });
      try {
        await vi.waitFor(() => expect(replacementPreflight).toHaveBeenCalledTimes(1));
        await expect(
          queue.enqueue("cancelled", {} as DiscordIngressPayload),
        ).resolves.toMatchObject({ kind: "completed" });
      } finally {
        await replacement.deactivate();
      }
    });
  });

  it.each(["returns", "throws"] as const)(
    "preserves retry facts when a started durable Discord job %s after cancellation",
    async (outcome) => {
      await withQueue(async (queue) => {
        const id = `started-cancelled-${outcome}`;
        const raw = rawMessage(id, "lane-a", Date.now());
        await queue.enqueue(
          id,
          { version: 1, receivedAt: 10, rawMessage: raw },
          { laneKey: "channel:lane-a", receivedAt: 10 },
        );
        const failedClaim = await queue.claim(id, { ownerId: "failed-owner" });
        if (!failedClaim) {
          throw new Error("Expected the started-job fixture claim");
        }
        await queue.release(failedClaim, {
          lastError: "previous genuine failure",
          releasedAt: 20,
        });
        const before = (await queue.listPending())[0];
        const processingStarted = createDeferred<void>();
        const finishProcessing = createDeferred<void>();
        let processingSignal: AbortSignal | undefined;
        const processDiscordMessage = vi.fn(async (ctx: { abortSignal?: AbortSignal }) => {
          processingSignal = ctx.abortSignal;
          processingStarted.resolve();
          await finishProcessing.promise;
          if (outcome === "throws") {
            throw new Error("processing stopped after cancellation");
          }
        });
        const params = createDiscordHandlerParams();
        const handler = createDiscordMessageHandler({
          ...params,
          client: {} as never,
          testing: {
            preflightDiscordMessage: (async (preflightParams: {
              abortSignal?: AbortSignal;
              data: DiscordMessagePreflightParams["data"];
              turnAdoptionLifecycle?: DiscordIngressLifecycle;
            }) => ({
              ...createDiscordQueuePreflightContextForMessage(preflightParams.data),
              abortSignal: preflightParams.abortSignal,
              turnAdoptionLifecycle: preflightParams.turnAdoptionLifecycle,
            })) as never,
            processDiscordMessage: processDiscordMessage as never,
            createIngressMonitor: (monitorParams) =>
              createDiscordIngressMonitor({ ...monitorParams, queue }),
          },
        });

        await processingStarted.promise;
        const deactivation = handler.deactivate();
        await vi.waitFor(() => expect(processingSignal?.aborted).toBe(true));
        finishProcessing.resolve();
        await deactivation;

        expect(await queue.listPending()).toEqual([
          expect.objectContaining({
            id,
            attempts: before?.attempts,
            lastAttemptAt: before?.lastAttemptAt,
            lastError: before?.lastError,
          }),
        ]);

        const recovered = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
          await lifecycle.onAdopted();
        });
        const replacement = createDiscordIngressMonitor({
          accountId: "default",
          client: {} as never,
          runtime: params.runtime,
          queue,
          dispatch: recovered,
        });
        replacement.start();
        try {
          await vi.waitFor(() => expect(recovered).toHaveBeenCalledTimes(1));
          await expect(queue.enqueue(id, {} as DiscordIngressPayload)).resolves.toMatchObject({
            kind: "completed",
          });
        } finally {
          await replacement.stop();
        }
      });
    },
  );

  it("preserves retry facts when deactivation skips a queued durable Discord job", async () => {
    await withQueue(async (queue) => {
      const raw = rawMessage("queued-cancelled", "lane-a", Date.now());
      await queue.enqueue(
        "queued-cancelled",
        { version: 1, receivedAt: 10, rawMessage: raw },
        { laneKey: "channel:lane-a", receivedAt: 10 },
      );
      const failedClaim = await queue.claim("queued-cancelled", { ownerId: "failed-owner" });
      if (!failedClaim) {
        throw new Error("Expected the queued-job fixture claim");
      }
      await queue.release(failedClaim, {
        lastError: "previous genuine failure",
        releasedAt: 20,
      });
      const before = (await queue.listPending())[0];
      const params = createDiscordHandlerParams();
      const processDiscordMessage = vi.fn(async () => {});
      const messageRunQueue = createDiscordMessageRunQueue({
        runtime: params.runtime,
        testing: { processDiscordMessage: processDiscordMessage as never },
      });
      const skipped = createDeferred<void>();
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: params.runtime,
        queue,
        dispatch: async (_event, lifecycle) => {
          const ingress = fanInChannelIngressLifecycles([lifecycle]);
          messageRunQueue.enqueue({
            context: await createBaseDiscordMessageContext(),
            ingressSettlement: ingress,
          });
          await messageRunQueue.deactivate();
          skipped.resolve();
          return { kind: "deferred" };
        },
      });
      monitor.start();
      try {
        await skipped.promise;
        await monitor.stop();
        expect(processDiscordMessage).not.toHaveBeenCalled();
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({
            id: "queued-cancelled",
            attempts: before?.attempts,
            lastAttemptAt: before?.lastAttemptAt,
            lastError: before?.lastError,
          }),
        ]);
      } finally {
        await monitor.stop();
        await messageRunQueue.deactivate();
      }

      const recovered = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
        await lifecycle.onAdopted();
      });
      const replacement = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: params.runtime,
        queue,
        dispatch: recovered,
      });
      replacement.start();
      try {
        await vi.waitFor(() => expect(recovered).toHaveBeenCalledTimes(1));
        await expect(
          queue.enqueue("queued-cancelled", {} as DiscordIngressPayload),
        ).resolves.toMatchObject({ kind: "completed" });
      } finally {
        await replacement.stop();
      }
    });
  });
});
