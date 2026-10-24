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
import { afterEach, expect, it, vi } from "vitest";
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
    return { ev: new EventEmitter(), ws, end() {}, user: { id: "15559876543@s.whatsapp.net" } };
  }),
  waitForWaConnection: vi.fn(async () => {}),
}));

type ListenerFactory = NonNullable<Parameters<typeof monitorWebChannel>[1]>;
type ReplyResolver = NonNullable<Parameters<typeof monitorWebChannel>[3]>;
const peer = "+15551234567";
const replyText = "Reply after an unrelated reload.";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

async function checkReload(root: string, accountId: string, changeChannel: boolean) {
  const named = accountId === "work";
  const authDir = path.join(root, "auth");
  const authoredConfig: OpenClawConfig = {
    agents: { defaults: { workspace: path.join(root, "workspace") } },
    session: { dmScope: "per-channel-peer" },
    channels: {
      whatsapp: named
        ? {
            textChunkLimit: 100,
            responsePrefix: "[ROOT]",
            accounts: {
              default: { responsePrefix: "[SHARED]", textChunkLimit: 1200 },
              work: { allowFrom: [peer], authDir },
            },
          }
        : { allowFrom: [peer], accounts: { default: { authDir } } },
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
  const finalText = named ? `${replyText} ${"x".repeat(150)}` : replyText;
  const resolver = vi.fn<ReplyResolver>(async () => {
    const nextCfg: OpenClawConfig = {
      ...cfg,
      logging: { level: "debug" },
      channels: changeChannel
        ? { whatsapp: { ...cfg.channels?.whatsapp, textChunkLimit: 2000 } }
        : cfg.channels,
    };
    const next = createTestRegistry([...old.channels], { config: nextCfg });
    setActivePluginRegistry(next);
    owner.publish(next);
    return { text: finalText };
  });
  const run = withPluginRuntimeRegistryScope(old, () =>
    monitorWebChannel(false, listenerFactory, true, resolver, undefined, abort.signal, {
      accountId,
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
    const message = createTestWebInboundMessage({
      event: { id: `reload-${accountId}-${changeChannel}`, timestamp: 1_700_000_000_000 },
      platform: {
        senderE164: peer,
        selfE164: "+15559876543",
        reply: async () => {
          throw new Error("Expected durable send");
        },
      },
      admission: { accountId },
    });
    await withPluginRuntimeRegistryScope(old, () => onMessage(message));
    expect(resolver).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls).toHaveLength(changeChannel ? 0 : 1);
    if (!changeChannel) {
      const call = sendMessage.mock.calls[0]!;
      expect({ to: call[0], text: call[1], options: call[4] }).toMatchObject({
        to: peer,
        text: named ? `[SHARED] ${finalText}` : finalText,
        options: { accountId },
      });
    }
  } finally {
    abort.abort();
    await run;
    await owner.close();
    vi.unstubAllEnvs();
  }
}

it.each([
  { accountId: "default", changeChannel: false },
  { accountId: "work", changeChannel: false },
  { accountId: "work", changeChannel: true },
])(
  "WhatsApp reload: account=$accountId relevantChange=$changeChannel",
  ({ accountId, changeChannel }) =>
    withTempHome((root) => checkReload(root, accountId, changeChannel)),
);
