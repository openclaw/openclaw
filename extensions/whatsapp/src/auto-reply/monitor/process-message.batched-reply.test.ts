import path from "node:path";
import type { WASocket } from "baileys";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { buildReplyPayloads } from "openclaw/plugin-sdk/reply-payload-testing";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  buildNotifyMessageUpsert,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  startInboxMonitor,
  waitForInboundWorkDrained,
  type InboxMonitorOptions,
} from "../../monitor-inbox.test-harness.js";
import {
  boundarySelf as self,
  boundaryPeer as peer,
  boundaryAccount as accountId,
  createReplyBoundary,
  registerReplyBoundary,
  type ReplyResolver,
} from "./reply-boundary.test-helper.js";

installWebMonitorInboxUnitTestHooks();

describe("WhatsApp debounce reply quoting boundary", () => {
  it.each([
    { debounceMs: 250, expectedQuoteIds: [undefined, undefined] },
    { debounceMs: 2_000, expectedQuoteIds: ["2000-second-message"] },
  ])("quotes only a coalesced turn with a $debounceMs ms window", async (scenario) => {
    await withTempHome(
      async (root) => {
        const firstMessageId = `${scenario.debounceMs}-first-message`;
        const secondMessageId = `${scenario.debounceMs}-second-message`;
        const laterMessageId = `${scenario.debounceMs}-later-message`;
        const boundary = await createReplyBoundary(root, peer, {
          channel: { replyToMode: "batched" },
        });
        const { cfg, backgroundTasks } = boundary;
        mockLoadConfig.mockReturnValue(cfg);
        getSock().user.id = `${self.slice(1)}@s.whatsapp.net`;
        const replyResolver = vi.fn<ReplyResolver>(async (ctx) => {
          // Replace model output only; the production payload owner resolves quote policy.
          const { replyPayloads } = await buildReplyPayloads({
            config: cfg,
            payloads: [{ text: "plain model answer" }],
            isHeartbeat: false,
            blockStreamingEnabled: false,
            blockReplyPipeline: null,
            replyToMode: "batched",
            replyToChannel: "whatsapp",
            currentMessageId: ctx.MessageSidFull ?? ctx.MessageSid,
            replyThreading: ctx.ReplyThreading,
            originatingChannel: ctx.OriginatingChannel,
            originatingChatType: ctx.ChatType,
            originatingTo: ctx.OriginatingTo,
            accountId: ctx.AccountId,
          });
          return replyPayloads;
        });
        let dispatchGate = Promise.withResolvers<void>();
        let scheduled = Promise.withResolvers<void>();
        const inboundQueue: NonNullable<InboxMonitorOptions["durableInboundQueue"]> =
          createChannelIngressQueueForTests({
            channelId: "whatsapp",
            accountId,
            stateDir: path.join(root, "ingress"),
          });
        const { listener, sock } = await startInboxMonitor(
          async (msg) => {
            // Advance debounce time without freezing the real database and delivery workers.
            await dispatchGate.promise;
            await boundary.process(msg, replyResolver);
          },
          {
            cfg,
            accountId,
            debounceMs: scenario.debounceMs,
            authDir: path.join(root, "auth"),
            durableInboundQueue: inboundQueue,
            shouldDebounce: () => {
              scheduled.resolve();
              return true;
            },
          },
        );
        const registration = registerReplyBoundary(listener);
        const enqueue = async (id: string, body: string) => {
          scheduled = Promise.withResolvers<void>();
          sock.ev.emit(
            "messages.upsert",
            buildNotifyMessageUpsert({
              id,
              remoteJid: `${peer.slice(1)}@s.whatsapp.net`,
              text: body,
              timestamp: Math.floor(Date.now() / 1_000),
            }),
          );
          await scheduled.promise;
        };
        const quoteIds = () =>
          sock.sendMessage.mock.calls.map(
            (call: Parameters<WASocket["sendMessage"]>) => call[2]?.quoted?.key?.id,
          );
        const completeFlush = async () => {
          vi.useRealTimers();
          dispatchGate.resolve();
          await waitForInboundWorkDrained();
          await Promise.all(backgroundTasks);
          dispatchGate = Promise.withResolvers<void>();
        };
        const useDebounceClock = () =>
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
        useDebounceClock();
        try {
          await enqueue(firstMessageId, "first batch input");
          // The failed live scenario's observed arrival gap exceeded its original window.
          await vi.advanceTimersByTimeAsync(858);
          if (scenario.debounceMs < 858) {
            await completeFlush();
            useDebounceClock();
          }
          await enqueue(secondMessageId, "second batch input");
          await vi.advanceTimersByTimeAsync(scenario.debounceMs);
          await completeFlush();

          expect(replyResolver).toHaveBeenCalledTimes(scenario.expectedQuoteIds.length);
          expect(quoteIds()).toEqual(scenario.expectedQuoteIds);
          expect(replyResolver.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual(
            scenario.debounceMs > 858
              ? ["first batch input\nsecond batch input"]
              : ["first batch input", "second batch input"],
          );

          useDebounceClock();
          await enqueue(laterMessageId, "separate unbatched input");
          await vi.advanceTimersByTimeAsync(scenario.debounceMs);
          await completeFlush();
          expect(quoteIds()).toEqual([...scenario.expectedQuoteIds, undefined]);
          expect(replyResolver.mock.calls.at(-1)?.[0].MessageSid).toBe(laterMessageId);
        } finally {
          vi.useRealTimers();
          dispatchGate.resolve();
          await listener.close();
          await Promise.allSettled(backgroundTasks);
          registration.dispose();
        }
      },
      {
        prefix: "whatsapp-batched-reply-boundary-",
        env: { OPENCLAW_CONFIG_PATH: (root) => path.join(root, ".openclaw", "openclaw.json") },
      },
    );
  });
});
