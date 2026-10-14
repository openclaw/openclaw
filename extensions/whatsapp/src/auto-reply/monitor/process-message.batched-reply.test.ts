import fs from "node:fs/promises";
import path from "node:path";
import type { WASocket } from "baileys";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildReplyPayloads } from "openclaw/plugin-sdk/reply-payload-testing";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "../../channel.js";
import { WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY } from "../../connection-controller-runtime-context.js";
import {
  buildNotifyMessageUpsert,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  startInboxMonitor,
  waitForInboundWorkDrained,
  type InboxMonitorOptions,
} from "../../monitor-inbox.test-harness.js";
import { getWhatsAppChannelRuntime } from "../../runtime.js";
import { processMessage } from "./process-message.js";

type ReplyResolver = Parameters<typeof processMessage>[0]["replyResolver"];

installWebMonitorInboxUnitTestHooks();

describe("WhatsApp debounce reply quoting boundary", () => {
  it.each([
    { debounceMs: 250, expectedQuoteIds: [undefined, undefined] },
    { debounceMs: 2_000, expectedQuoteIds: ["2000-second-message"] },
  ])("quotes only a coalesced turn with a $debounceMs ms window", async (scenario) => {
    await withTempHome(
      async (root) => {
        const self = "+12025550100";
        const peer = "+12025550101";
        const accountId = "work";
        const firstMessageId = `${scenario.debounceMs}-first-message`;
        const secondMessageId = `${scenario.debounceMs}-second-message`;
        const laterMessageId = `${scenario.debounceMs}-later-message`;
        const backgroundTasks = new Set<Promise<unknown>>();
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: path.join(root, "workspace"),
            },
          },
          session: { dmScope: "per-channel-peer" },
          channels: {
            whatsapp: {
              replyToMode: "batched",
              accounts: { work: { authDir: path.join(root, "auth"), allowFrom: [peer] } },
            },
          },
        };
        await fs.writeFile(path.join(root, ".openclaw", "openclaw.json"), JSON.stringify(cfg));
        mockLoadConfig.mockReturnValue(cfg);
        getSock().user.id = `${self.slice(1)}@s.whatsapp.net`;
        const replyResolver = vi.fn<ReplyResolver>(async (ctx) => {
          // Replace model output only; the production payload owner resolves quote policy.
          const { replyPayloads } = await buildReplyPayloads({
            config: cfg,
            payloads: [{ text: "plain model answer" }],
            isHeartbeat: false,
            didLogHeartbeatStrip: false,
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
        const route = resolveAgentRoute({
          cfg,
          channel: "whatsapp",
          accountId,
          peer: { kind: "direct", id: peer },
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
            await processMessage({
              cfg,
              msg,
              route,
              groupHistoryKey: `whatsapp:${accountId}:direct:${peer}`,
              groupHistories: new Map(),
              groupMemberNames: new Map(),
              connectionId: "batched-reply-proof",
              verbose: false,
              maxMediaBytes: 1_000_000,
              replyResolver,
              replyLogger: getChildLogger({ module: "whatsapp-batched-reply-boundary" }),
              backgroundTasks,
              ackAlreadySent: true,
            });
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
        const priorRegistry = getActivePluginRegistry();
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "whatsapp", source: "test", plugin: whatsappPlugin }]),
        );
        const registration = registerChannelRuntimeContext({
          channelRuntime: getWhatsAppChannelRuntime(),
          channelId: "whatsapp",
          accountId,
          capability: WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY,
          context: {
            getActiveListener: () => listener,
            getCurrentSock: () => null,
            getSelfIdentity: () => ({ e164: self, jid: `${self.slice(1)}@s.whatsapp.net` }),
          },
        });
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
          registration?.dispose();
          if (priorRegistry) {
            setActivePluginRegistry(priorRegistry);
          } else {
            resetPluginRuntimeStateForTest();
          }
        }
      },
      {
        prefix: "whatsapp-batched-reply-boundary-",
        env: { OPENCLAW_CONFIG_PATH: (root) => path.join(root, ".openclaw", "openclaw.json") },
      },
    );
  });
});
