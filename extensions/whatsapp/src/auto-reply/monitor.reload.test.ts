import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { withPluginRuntimeRegistryScope } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginRegistryOwner,
  createPluginRuntimeMock,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "../channel.js";
import { createAcceptedWhatsAppSendResult } from "../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../inbound/test-message.test-helper.js";
import type { ActiveWebListener } from "../inbound/types.js";
import { setWhatsAppRuntime } from "../runtime.js";
import { monitorWebChannel } from "./monitor.js";

vi.mock("../session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.js")>()),
  createWaSocket: vi.fn(async () => {
    const ws = Object.assign(new EventEmitter(), {
      close() {
        ws.isClosed = true;
        ws.emit("close");
      },
      isClosed: false,
      isClosing: false,
    });
    return { ev: new EventEmitter(), ws, end() {}, user: { id: "12025550100@s.whatsapp.net" } };
  }),
  waitForWaConnection: vi.fn(async () => {}),
}));

type ListenerFactory = NonNullable<Parameters<typeof monitorWebChannel>[1]>;
type ReplyResolver = NonNullable<Parameters<typeof monitorWebChannel>[3]>;
const peer = "+12025550101";
const replyText = "Reply after an unrelated reload.";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

describe("WhatsApp monitor final reply across registry reload", () => {
  it.each([
    { accountId: "default", named: false, changeChannel: false },
    { accountId: "work", named: true, changeChannel: false },
    { accountId: "work", named: true, changeChannel: true },
  ])("account=$accountId relevantChange=$changeChannel", async (scenario) => {
    await withTempHome(
      async (root) => {
        const authoredConfig: OpenClawConfig = {
          agents: { defaults: { workspace: path.join(root, "workspace") } },
          session: { dmScope: "per-channel-peer" },
          channels: {
            whatsapp: scenario.named
              ? {
                  textChunkLimit: 4000,
                  responsePrefix: "[ROOT]",
                  accounts: {
                    default: { responsePrefix: "[SHARED]", textChunkLimit: 1200 },
                    work: { allowFrom: [peer], authDir: path.join(root, "auth") },
                  },
                }
              : { allowFrom: [peer], accounts: { default: { authDir: path.join(root, "auth") } } },
          },
        };
        const configPath = path.join(root, ".openclaw", "openclaw.json");
        await fs.writeFile(configPath, JSON.stringify(authoredConfig));
        vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
        clearRuntimeConfigSnapshot();
        const cfg = getRuntimeConfig();
        setWhatsAppRuntime(createPluginRuntimeMock());
        const old = createTestRegistry(
          [{ pluginId: "whatsapp", source: "test", plugin: whatsappPlugin }],
          { config: cfg },
        );
        setActivePluginRegistry(old);
        const owner = createPluginRegistryOwner(old);
        const sendMessage = vi.fn<ActiveWebListener["sendMessage"]>(async () =>
          createAcceptedWhatsAppSendResult("text", "reload-final-receipt"),
        );
        const connected = Promise.withResolvers<void>();
        const abort = new AbortController();
        let onMessage: Parameters<ListenerFactory>[0]["onMessage"];
        const listenerFactory: ListenerFactory = async (options) => {
          onMessage = options.onMessage;
          return {
            close: async () => {},
            onClose: new Promise<never>(() => {}),
            signalClose: () => {},
            assertSendReady: async () => {},
            sendMessage,
            sendPoll: async () => {
              throw new Error("Unexpected poll delivery");
            },
            sendComposingTo: async () => {},
            sendReaction: async () => createAcceptedWhatsAppSendResult("reaction", "ack"),
          };
        };
        const resolver = vi.fn<ReplyResolver>(async () => {
          const nextCfg: OpenClawConfig = {
            ...cfg,
            logging: { level: "debug" },
            ...(scenario.changeChannel
              ? { channels: { whatsapp: { ...cfg.channels?.whatsapp, textChunkLimit: 2000 } } }
              : {}),
          };
          const next = createTestRegistry([...old.channels], { config: nextCfg });
          setActivePluginRegistry(next);
          owner.publish(next);
          return { text: replyText };
        });
        const run = withPluginRuntimeRegistryScope(old, () =>
          monitorWebChannel(false, listenerFactory, true, resolver, undefined, abort.signal, {
            accountId: scenario.accountId,
            statusSink: (status) => {
              if (status.connected) {
                connected.resolve();
              }
            },
          }),
        );
        try {
          await Promise.race([
            connected.promise,
            run.then(() => {
              throw new Error("Monitor stopped before connection");
            }),
          ]);
          await withPluginRuntimeRegistryScope(old, () =>
            onMessage(
              createTestWebInboundMessage({
                event: {
                  id: `reload-${scenario.accountId}-${scenario.changeChannel}`,
                  timestamp: 1_700_000_000_000,
                },
                payload: { body: "please reply" },
                platform: {
                  chatJid: "12025550101@s.whatsapp.net",
                  recipientJid: "+12025550100",
                  senderE164: peer,
                  selfE164: "+12025550100",
                  reply: async () => {
                    throw new Error("Expected durable send");
                  },
                },
                admission: {
                  accountId: scenario.accountId,
                  conversation: { kind: "direct", id: peer },
                  sender: { id: peer },
                },
              }),
            ),
          );
          expect(resolver).toHaveBeenCalledOnce();
          if (scenario.changeChannel) {
            expect(sendMessage).not.toHaveBeenCalled();
          } else {
            expect(sendMessage).toHaveBeenCalledOnce();
            expect(sendMessage.mock.calls[0]).toEqual(
              expect.arrayContaining([peer, scenario.named ? `[SHARED] ${replyText}` : replyText]),
            );
            expect(sendMessage.mock.calls[0]?.[4]).toMatchObject({ accountId: scenario.accountId });
          }
        } finally {
          abort.abort();
          await run;
          await owner.close();
          vi.unstubAllEnvs();
        }
      },
      { prefix: "whatsapp-monitor-reload-" },
    );
  });
});
