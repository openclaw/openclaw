import { EventDispatcher } from "@larksuiteoapi/node-sdk";
import {
  createChannelIngressQueueForTests,
  observeChannelIngressQueueWrite,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import { createPluginRuntimeMock, createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuBroadcastIngressSettlement } from "./bot-broadcast.js";
import type { handleFeishuMessage } from "./bot.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import type { FeishuMessageProcessingClaim } from "./dedup.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";
import { monitorSingleAccount } from "./monitor.account.js";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  createDispatcher: vi.fn(),
  chatLookup: vi.fn(),
  runtime: vi.fn(),
  transport: vi.fn(),
  warmup: vi.fn(),
  claim: vi.fn(),
  forget: vi.fn(),
  menu: vi.fn(),
  handleMessage: vi.fn(),
  parseMessage: vi.fn(),
  stopBindings: vi.fn(),
  createBindings: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createEventDispatcher: mocks.createDispatcher,
  createFeishuClient: () => ({ im: { chat: { get: mocks.chatLookup } } }),
}));
vi.mock("./runtime.js", () => ({ getFeishuRuntime: mocks.runtime }));
vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: mocks.transport,
  monitorWebhook: mocks.transport,
}));
vi.mock("./dedup.js", () => ({
  warmupDedupFromPluginState: mocks.warmup,
  claimUnprocessedFeishuMessage: mocks.claim,
  forgetProcessedFeishuMessage: mocks.forget,
  hasProcessedFeishuMessage: vi.fn(async () => false),
}));
vi.mock("./card-ux-launcher.js", () => ({ maybeHandleFeishuQuickActionMenu: mocks.menu }));
vi.mock("./bot.js", () => ({
  handleFeishuMessage: mocks.handleMessage,
  parseFeishuMessageEvent: mocks.parseMessage,
}));
vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: mocks.createBindings,
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.warmup.mockResolvedValue(0);
  mocks.parseMessage.mockReturnValue({ content: "hello" });
  mocks.createDispatcher.mockReturnValue({ register: mocks.register });
  mocks.menu.mockResolvedValue(true);
  mocks.forget.mockResolvedValue(true);
  mocks.createBindings.mockReturnValue({ stop: mocks.stopBindings });
});

function startAccount(controller: AbortController, vcAutoJoin = false) {
  const cfg = {
    channels: {
      feishu: {
        accounts: {
          test: { appId: "fixture-app", appSecret: "fixture-secret", vcAutoJoin },
        },
      },
    },
  };
  return monitorSingleAccount({
    cfg,
    account: resolveFeishuAccount({ cfg, accountId: "test" }),
    abortSignal: controller.signal,
    botOpenIdSource: { kind: "prefetched", botOpenId: "fixture-bot", source: "provider" },
    channelRuntime: createPluginRuntimeMock().channel,
    runtime: createRuntimeEnv(),
  });
}

describe("Feishu account replay work ownership", () => {
  it.each(["message", "broadcast", "evicted-handler"] as const)(
    "joins %s settlement after transport ownership ends",
    async (kind) => {
      await withOpenClawTestState({ label: "feishu-deferred-commit" }, async (state) => {
        const controller = new AbortController();
        const ready = createDeferred<EventDispatcher>();
        const deferred = createDeferred<FeishuIngressLifecycle>();
        const commitStarted = createDeferred<void>();
        const commitGate = createDeferred<void>();
        const evicted = createDeferred<boolean>();
        const transportClosed = createDeferred<void>();
        const claim: FeishuMessageProcessingClaim = {
          keys: ["deferred-message"],
          commit: vi.fn(async () => {
            if (kind !== "broadcast") {
              commitStarted.resolve();
              await commitGate.promise;
            }
            return true;
          }),
          release: vi.fn(),
        };
        const broadcastClaim: FeishuMessageProcessingClaim = {
          keys: ["deferred-broadcast"],
          commit: vi.fn(async () => {
            commitStarted.resolve();
            await commitGate.promise;
            return true;
          }),
          release: vi.fn(),
        };
        mocks.claim.mockResolvedValue({ kind: "claimed", handle: claim });
        mocks.createDispatcher.mockImplementation(() => new EventDispatcher({}));
        mocks.handleMessage.mockImplementation(
          async ({
            turnAdoptionLifecycle,
            trackTask,
          }: Parameters<typeof import("./bot.js").handleFeishuMessage>[0]) => {
            if (!turnAdoptionLifecycle) {
              throw new Error("Missing registered message lifecycle");
            }
            if (kind === "evicted-handler") {
              await claim.commit();
              return;
            }
            if (kind === "broadcast") {
              const broadcast = createFeishuBroadcastIngressSettlement({
                lifecycle: turnAdoptionLifecycle,
                replayClaim: broadcastClaim,
                trackTask,
              });
              const lane = broadcast.createLane();
              lane.lifecycle.onDeferred();
              await broadcast.onDispatchComplete();
              deferred.resolve(lane.lifecycle);
              return;
            }
            turnAdoptionLifecycle.onDeferred();
            deferred.resolve(turnAdoptionLifecycle);
          },
        );
        mocks.transport.mockImplementation(
          async ({ eventDispatcher }: { eventDispatcher: EventDispatcher }) => {
            ready.resolve(eventDispatcher);
            if (!controller.signal.aborted) {
              await new Promise<void>((resolve) => {
                controller.signal.addEventListener("abort", () => resolve(), { once: true });
              });
            }
            transportClosed.resolve();
          },
        );
        const queue = createChannelIngressQueueForTests({
          channelId: "feishu",
          accountId: "test",
          stateDir: state.stateDir,
        });
        mocks.runtime.mockReturnValue(
          createPluginRuntimeMock({
            state: {
              openChannelIngressQueue: <T, TMetadata = unknown, TCompletedMetadata = unknown>() => {
                const ingressQueue = createChannelIngressQueueForTests<
                  T,
                  TMetadata,
                  TCompletedMetadata
                >({
                  channelId: "feishu",
                  accountId: "test",
                  stateDir: state.stateDir,
                });
                void observeChannelIngressQueueWrite(ingressQueue, "release").then(
                  evicted.resolve,
                  evicted.reject,
                );
                return ingressQueue;
              },
            },
          }),
        );
        let stopped = false;
        const monitor = startAccount(controller).then(() => {
          stopped = true;
        });
        void monitor.catch(ready.reject);
        let adoption: Promise<void> | undefined;
        try {
          const dispatcher = await ready.promise;
          if (kind === "evicted-handler") {
            await queue.listPending();
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          }
          await dispatcher.invoke({
            schema: "2.0",
            header: {
              event_id: "evt-deferred-commit",
              event_type: "im.message.receive_v1",
            },
            event: {
              sender: { sender_id: { open_id: "fixture-user" }, sender_type: "user" },
              message: {
                message_id: "om-deferred-commit",
                chat_id: "oc-test",
                chat_type: kind === "broadcast" ? "group" : "p2p",
                message_type: "text",
                content: JSON.stringify({ text: "hello" }),
              },
            },
          });
          if (kind === "evicted-handler") {
            await commitStarted.promise;
            await vi.advanceTimersByTimeAsync(5 * 60_000);
            vi.useRealTimers();
            await expect(evicted.promise).resolves.toBe(true);
          } else {
            const lifecycle = await deferred.promise;
            adoption = Promise.resolve(lifecycle.onAdopted());
          }
          await commitStarted.promise;
          if (kind !== "evicted-handler") {
            expect(await queue.listPending()).toEqual([]);
          }
          expect(await queue.listClaims()).toEqual([]);
          controller.abort();
          await transportClosed.promise;
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(stopped).toBe(false);
          expect(mocks.stopBindings).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
          commitGate.resolve();
          controller.abort();
          await adoption;
          await monitor;
        }
        expect(claim.commit).toHaveBeenCalledOnce();
        if (kind === "evicted-handler") {
          expect(claim.release).toHaveBeenCalled();
        } else {
          expect(claim.release).not.toHaveBeenCalled();
        }
        expect(broadcastClaim.commit).toHaveBeenCalledTimes(kind === "broadcast" ? 1 : 0);
        expect(broadcastClaim.release).not.toHaveBeenCalled();
        expect(mocks.stopBindings).toHaveBeenCalledOnce();
      });
    },
  );

  it.each(["card", "meeting", "card-broadcast"] as const)(
    "joins an accepted %s commit and rejects new events after shutdown",
    async (kind) => {
      await withOpenClawTestState({ label: `feishu-${kind}-commit` }, async (state) => {
        const controller = new AbortController();
        const ready = createDeferred<(event: unknown) => Promise<void>>();
        const transportClosed = createDeferred<void>();
        const commitStarted = createDeferred<void>();
        const commitGate = createDeferred<void>();
        const guard = createChannelReplayGuard<string>({
          dedupe: {
            ttlMs: 60_000,
            memoryMaxSize: 0,
            pluginId: "feishu",
            stateMaxEntries: 10,
            env: { ...process.env, OPENCLAW_STATE_DIR: state.stateDir },
          },
          buildReplayKey: (key) => key,
        });
        const lookupStarted = createDeferred<void>();
        const lookupGate = createDeferred<void>();
        mocks.chatLookup.mockImplementation(async () => {
          lookupStarted.resolve();
          await lookupGate.promise;
          return { code: 0, data: { chat_type: "group" } };
        });
        const claimed = await guard.claim(kind);
        if (claimed.kind !== "claimed") {
          throw new Error("Expected synthetic event replay claim");
        }
        const commit = claimed.handle.commit;
        if (kind === "meeting") {
          mocks.claim.mockResolvedValue(claimed);
        }
        const processingFinished = createDeferred<void>();
        const broadcastDeferred = createDeferred<void>();
        let broadcastLane: FeishuIngressLifecycle | undefined;
        let broadcastAdoption: Promise<void> | undefined;
        vi.spyOn(claimed.handle, "commit").mockImplementation(async () => {
          commitStarted.resolve();
          await commitGate.promise;
          return commit();
        });
        mocks.handleMessage.mockImplementation(
          async ({
            trackTask,
            turnAdoptionLifecycle,
          }: Parameters<typeof handleFeishuMessage>[0]) => {
            try {
              if (kind === "card-broadcast") {
                const broadcast = createFeishuBroadcastIngressSettlement({
                  replayClaim: claimed.handle,
                  trackTask,
                });
                broadcastLane = broadcast.createLane().lifecycle;
                broadcastLane.onDeferred();
                await broadcast.onDispatchComplete();
                broadcastDeferred.resolve();
                return;
              }
              if (kind === "meeting") {
                await turnAdoptionLifecycle?.onAdopted();
              } else {
                await claimed.handle.commit();
              }
            } finally {
              processingFinished.resolve();
            }
          },
        );
        const eventType = kind === "meeting" ? "vc.bot.meeting_invited_v1" : "card.action.trigger";
        mocks.register.mockImplementation(
          (handlers: Record<string, (event: unknown) => Promise<void>>) => {
            const handler = handlers[eventType];
            if (!handler) {
              throw new Error("Synthetic event handler was not registered");
            }
            ready.resolve(handler);
          },
        );
        mocks.transport.mockImplementation(async () => {
          if (!controller.signal.aborted) {
            await new Promise<void>((resolve) => {
              controller.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
          transportClosed.resolve();
        });
        const event =
          kind !== "meeting"
            ? {
                token: `fixture-${kind}-settlement`,
                operator: { open_id: "fixture-user" },
                action: {
                  tag: "button",
                  value: createFeishuCardInteractionEnvelope({
                    k: "quick",
                    a: "help",
                    q: "/help",
                    c: {
                      u: "fixture-user",
                      h: `oc-${kind}-settlement`,
                      e: Date.now() + 60_000,
                    },
                  }),
                },
                context: { chat_id: `oc-${kind}-settlement` },
              }
            : {
                event_id: "fixture-meeting",
                meeting: { meeting_no: "123456789" },
                inviter: { id: { open_id: "fixture-user" } },
                invite_time: "1712345678",
              };
        let stopped = false;
        const monitor = startAccount(controller, true).then(() => {
          stopped = true;
        });
        void monitor.catch(ready.reject);
        try {
          const handler = await ready.promise;
          const acknowledgement = handler(event);
          await (kind !== "meeting" ? lookupStarted.promise : commitStarted.promise);
          await acknowledgement;
          controller.abort();
          await transportClosed.promise;
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(stopped).toBe(false);
          expect(mocks.stopBindings).not.toHaveBeenCalled();
          if (kind !== "meeting") {
            expect(mocks.handleMessage).not.toHaveBeenCalled();
            lookupGate.resolve();
            if (kind === "card-broadcast") {
              await broadcastDeferred.promise;
              await processingFinished.promise;
              await new Promise<void>((resolve) => {
                setImmediate(resolve);
              });
              expect(stopped).toBe(false);
              broadcastAdoption = Promise.resolve(broadcastLane?.onAdopted());
            }
            await commitStarted.promise;
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(stopped).toBe(false);
          }
          commitGate.resolve();
          await monitor;
          expect(await guard.hasRecent(kind)).toBe(true);
          await handler({ ...event, token: "fixture-after-stop", event_id: "fixture-after-stop" });
          expect(mocks.handleMessage).toHaveBeenCalledOnce();
          expect(claimed.handle.commit).toHaveBeenCalledOnce();
        } finally {
          lookupGate.resolve();
          commitGate.resolve();
          controller.abort();
          await processingFinished.promise;
          if (broadcastLane && !broadcastAdoption) {
            broadcastAdoption = Promise.resolve(broadcastLane.onAdopted());
          }
          await broadcastAdoption;
          await monitor;
        }
        expect(mocks.stopBindings).toHaveBeenCalledOnce();
      });
    },
  );

  it("does not start account resources after abort during dedupe warmup", async () => {
    const controller = new AbortController();
    const warmup = createDeferred<number>();
    mocks.warmup.mockReturnValue(warmup.promise);
    const monitor = startAccount(controller);
    controller.abort();
    warmup.resolve(1);
    await monitor;
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.createBindings).not.toHaveBeenCalled();
  });

  it.each([
    ["menu", "claim"],
    ["menu", "commit"],
    ["menu", "forget"],
    ["meeting", "claim"],
  ] as const)("joins detached %s %s before retiring the account", async (kind, phase) => {
    const controller = new AbortController();
    const reached = createDeferred<void>();
    const release = createDeferred<void>();
    const settled = createDeferred<void>();
    let claimStarted = false;
    const ready = createDeferred<(data: unknown) => Promise<void>>();
    const transportClosed = createDeferred<void>();
    const claim: FeishuMessageProcessingClaim = {
      keys: ["fixture-menu"],
      commit: vi.fn(async () => {
        if (phase === "commit") {
          reached.resolve();
          await release.promise;
        }
        settled.resolve();
        return true;
      }),
      release: vi.fn(() => settled.resolve()),
    };
    mocks.claim.mockImplementation(async () => {
      claimStarted = true;
      if (phase === "claim") {
        reached.resolve();
        await release.promise;
      }
      return { kind: "claimed", handle: claim };
    });
    if (phase === "forget") {
      mocks.forget.mockImplementation(async () => {
        reached.resolve();
        await release.promise;
        return true;
      });
      mocks.menu.mockRejectedValue(
        Object.assign(new Error("retryable-menu"), {
          name: "FeishuRetryableSyntheticEventError",
        }),
      );
    }
    mocks.register.mockImplementation(
      (handlers: Record<string, (data: unknown) => Promise<void>>) => {
        const menu =
          handlers[kind === "meeting" ? "vc.bot.meeting_invited_v1" : "application.bot.menu_v6"];
        if (!menu) {
          throw new Error("Menu handler was not registered");
        }
        ready.resolve(menu);
      },
    );
    mocks.transport.mockImplementation(async () => {
      if (!controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      transportClosed.resolve();
    });
    let stopped = false;
    const monitor = startAccount(controller, kind === "meeting").finally(() => {
      stopped = true;
    });
    void monitor.catch(ready.reject);
    try {
      const menu = await ready.promise;
      const acknowledgement = menu(
        kind === "meeting"
          ? {
              event_id: "fixture-pending-meeting",
              meeting: { meeting_no: "123456789" },
              inviter: { id: { open_id: "fixture-user" } },
              invite_time: "1712345678",
            }
          : {
              event_key: "quick-actions",
              timestamp: "fixture-time",
              operator: { operator_id: { open_id: "fixture-user" } },
            },
      );
      await reached.promise;
      if (phase !== "claim") {
        await acknowledgement;
      }
      controller.abort();
      await transportClosed.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(stopped).toBe(false);
      expect(mocks.stopBindings).not.toHaveBeenCalled();
      release.resolve();
      await acknowledgement;
      await monitor;
      expect(mocks.stopBindings).toHaveBeenCalledOnce();
      if (phase === "claim") {
        expect(mocks.menu).not.toHaveBeenCalled();
        expect(mocks.handleMessage).not.toHaveBeenCalled();
        expect(claim.release).toHaveBeenCalledOnce();
        expect(claim.commit).not.toHaveBeenCalled();
      } else if (phase === "commit") {
        expect(claim.commit).toHaveBeenCalledOnce();
        expect(claim.release).not.toHaveBeenCalled();
      } else {
        expect(mocks.forget).toHaveBeenCalledOnce();
        expect(claim.release).toHaveBeenCalledOnce();
      }
    } finally {
      release.resolve();
      controller.abort();
      await monitor;
      if (claimStarted) {
        await settled.promise;
      }
    }
  });
});
