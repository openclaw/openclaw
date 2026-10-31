import type { RequestListener } from "node:http";
import {
  runChannelInboundEvent,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import {
  createTestRegistry,
  createRuntimeEnv,
  readQueuedDeliveryEntriesForTest,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { matrixPlugin } from "../../channel.js";
import { installMatrixMonitorTestRuntime, resetMatrixTestStores } from "../../test-runtime.js";
import { MatrixClient } from "../sdk.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

const resolvedClient = vi.hoisted(() => ({ current: undefined as MatrixClient | undefined }));
// Recovery resolves the same account's client without starting an unrelated sync loop.
vi.mock("../client-bootstrap.js", () => ({
  withResolvedRuntimeMatrixClient: async (
    _options: unknown,
    run: (client: MatrixClient) => Promise<unknown>,
  ) => {
    if (!resolvedClient.current) {
      throw new Error("Matrix fixture client unavailable");
    }
    return await run(resolvedClient.current);
  },
}));

it.each([
  {
    name: "ordinary final",
    text: "The final answer.",
    eventCount: 1,
    threadId: undefined,
    priorBlock: false,
  },
  {
    name: "partially accepted threaded final",
    text: "answer ".repeat(20),
    eventCount: 2,
    threadId: "$thread",
    priorBlock: false,
  },
  {
    name: "final after the first reply slot was consumed",
    text: "The final answer.",
    eventCount: 1,
    threadId: undefined,
    priorBlock: true,
  },
])(
  "recovers $name after an uncertain HTTP timeout using its saved transactions",
  async ({ text, eventCount, threadId, priorBlock }) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-matrix-final-recovery-",
    });
    const roomId = "!room:example.org";
    const attempts: { path: string; content: Record<string, unknown> }[] = [];
    const visible = new Map<string, string>();
    const unexpected: string[] = [];
    const errors: string[] = [];
    const blockCount = priorBlock ? 1 : 0;
    const timeoutAt = eventCount + blockCount;
    const transport: RequestListener = (request, response) => {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const respond = (body: object, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (pathname.endsWith("/account/whoami")) {
          respond({ user_id: "@bot:example.org", device_id: "fixture" });
        } else if (pathname.includes("/state/m.room.encryption")) {
          respond({ errcode: "M_NOT_FOUND" }, 404);
        } else if (pathname.includes("/send/m.room.message/")) {
          const content = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
          attempts.push({ path: pathname, content });
          // Homeserver acceptance followed by a lost response is ambiguous to the sender.
          // Reusing the transaction must return the same event instead of duplicating it.
          const eventId = visible.get(pathname) ?? `$accepted-${visible.size + 1}`;
          visible.set(pathname, eventId);
          if (attempts.length !== timeoutAt) {
            respond({ event_id: eventId });
          }
        } else if (pathname.includes("/typing/") || pathname.includes("/receipt/")) {
          respond({});
        } else {
          unexpected.push(`${request.method} ${pathname}`);
          respond({ errcode: "M_UNRECOGNIZED" }, 400);
        }
      });
    };
    try {
      await withServer(transport, async (homeserver) => {
        const cfg = {
          session: { store: state.statePath("sessions.json") },
          channels: {
            matrix: {
              homeserver,
              userId: "@bot:example.org",
              accessToken: "fixture-token",
              textChunkLimit: 80,
              dm: { policy: "open" as const, allowFrom: ["*"] },
            },
          },
        };
        const client = new MatrixClient(homeserver, "fixture-token", {
          userId: "@bot:example.org",
          deviceId: "fixture",
          encryption: false,
          autoBootstrapCrypto: false,
          localTimeoutMs: 250,
          ssrfPolicy: { allowPrivateNetwork: true },
        });
        resolvedClient.current = client;
        installMatrixMonitorTestRuntime({ cfg, stateDir: state.stateDir });
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
        );
        const produceReply = vi.fn<NonNullable<ChannelInboundTurnPlan["dispatchReplyFromConfig"]>>(
          async ({ dispatcher }) => {
            if (priorBlock) {
              dispatcher.sendBlockReply({ text: "Earlier block", replyToId: "$quoted" });
            }
            dispatcher.sendFinalReply({ text, replyToId: "$quoted", replyToTag: !priorBlock });
            return { queuedFinal: true, counts: dispatcher.getQueuedCounts() };
          },
        );
        const { handler } = createMatrixHandlerTestHarness({
          cfg,
          accountId: "default",
          streaming: "off",
          replyToMode: "first",
          dmThreadReplies: "inbound",
          runtime: {
            ...createRuntimeEnv(),
            error: (message) => {
              errors.push(String(message));
            },
          },
          client: {
            sendMessage: client.sendMessage.bind(client),
            getTransactionScopeId: client.getTransactionScopeId.bind(client),
            getMessageWireEventType: client.getMessageWireEventType.bind(client),
            prepareRoomForMessageSend: client.prepareRoomForMessageSend.bind(client),
            getJoinedRoomMembers: async () => [],
          },
          runChannelInboundEvent: async (params) => {
            const resolveTurn = params.adapter.resolveTurn;
            return await runChannelInboundEvent({
              ...params,
              adapter: {
                ...params.adapter,
                resolveTurn: async (...args) => {
                  const turn = await resolveTurn(...args);
                  if (!("delivery" in turn) || !turn.delivery.deliver) {
                    throw new Error("Expected a Matrix core-managed delivery plan");
                  }
                  return {
                    ...turn,
                    delivery: { ...turn.delivery, deliver: turn.delivery.deliver },
                    dispatchReplyFromConfig: produceReply,
                  };
                },
              },
            });
          },
        });
        try {
          await handler(
            roomId,
            createMatrixTextMessageEvent({
              eventId: "$inbound",
              body: "Help",
              relatesTo: threadId ? { rel_type: "m.thread", event_id: threadId } : undefined,
            }),
          );
          expect(produceReply).toHaveBeenCalledOnce();
          expect(errors.join("\n")).toContain("aborted");
          expect(attempts).toHaveLength(timeoutAt);
          const initialAttempts = attempts.slice(blockCount);
          expect(initialAttempts[0]?.path).toContain("/oc_");
          for (const attempt of initialAttempts) {
            if (priorBlock) {
              expect(attempt.content).not.toHaveProperty("m.relates_to");
              continue;
            }
            expect(attempt.content["m.relates_to"]).toMatchObject({
              "m.in_reply_to": { event_id: "$quoted" },
              ...(threadId ? { rel_type: "m.thread", event_id: threadId } : {}),
            });
          }
          expect(readQueuedDeliveryEntriesForTest(state.stateDir)).toMatchObject([
            { channel: "matrix", recoveryState: "unknown_after_send" },
          ]);
          const drain = () =>
            drainPendingDeliveries({
              cfg,
              stateDir: state.stateDir,
              drainKey: "matrix:final-recovery-test",
              logLabel: "Matrix recovery",
              log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
              selectEntry: (entry) => ({ match: entry.channel === "matrix", bypassBackoff: true }),
            });
          await drain();
          expect(attempts.slice(timeoutAt)).toEqual(initialAttempts);
          expect(visible.size).toBe(timeoutAt);
          expect(readQueuedDeliveryEntriesForTest(state.stateDir)).toEqual([]);
          await drain();
          expect(attempts).toHaveLength(blockCount + eventCount * 2);
          expect(produceReply).toHaveBeenCalledOnce();
          expect(unexpected).toEqual([]);
        } finally {
          resolvedClient.current = undefined;
          await client.stopWithoutPersist();
        }
      });
    } finally {
      resetPluginRuntimeStateForTest();
      vi.restoreAllMocks();
      await resetMatrixTestStores();
      await state.cleanup();
    }
  },
);
