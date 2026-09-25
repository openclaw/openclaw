import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { getActiveWebListener } from "./active-listener.js";
import { getWhatsAppConnectionController } from "./connection-controller-runtime-context.js";
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";
import {
  getOptionalWhatsAppChannelRuntime,
  getWhatsAppRuntime,
  setWhatsAppRuntime,
} from "./runtime.js";
import { sendMessageWhatsApp } from "./send.js";

describe("WhatsApp native delivery after runtime replacement", () => {
  it("sends through the connection owner's retained channel context and releases its lease", async () => {
    const contexts = new Map<string, unknown>();
    const channel = (getOptionalWhatsAppChannelRuntime() ?? {
      runtimeContexts: {
        register: ({ accountId, context }: { accountId?: string; context: unknown }) => {
          contexts.set(accountId ?? "", context);
          return { dispose: () => contexts.delete(accountId ?? "") };
        },
        get: ({ accountId }: { accountId?: string }) => contexts.get(accountId ?? ""),
        watch: () => () => {},
      },
    }) as PluginRuntime["channel"];
    const originalRuntime = { channel } as PluginRuntime;
    const replacementRuntime = {
      channel: { runtimeContexts: { get: () => undefined } },
    } as unknown as PluginRuntime;
    const sendMessage = vi.fn(async () =>
      createAcceptedWhatsAppSendResult("text", "owned-message"),
    );
    const accountId = "runtime-owner-test";
    const listener = { sendMessage, sendComposingTo: vi.fn(async () => {}) };

    setWhatsAppRuntime(originalRuntime);
    const lease = registerChannelRuntimeContext({
      channelRuntime: channel,
      channelId: "whatsapp",
      accountId,
      capability: "connection-controller",
      context: { getActiveListener: () => listener },
    });
    try {
      setWhatsAppRuntime(replacementRuntime);
      expect(getWhatsAppRuntime()).toBe(replacementRuntime);
      expect(getWhatsAppConnectionController(accountId)?.getActiveListener()).toBe(listener);
      expect(getActiveWebListener(accountId)).toBe(listener);
      await expect(
        sendMessageWhatsApp("+15551234567", "after replacement", {
          cfg: { channels: { whatsapp: {} } },
          accountId,
          verbose: false,
        }),
      ).resolves.toMatchObject({ messageId: "owned-message" });
      expect(sendMessage).toHaveBeenCalledOnce();
    } finally {
      lease?.dispose();
    }
    expect(getWhatsAppConnectionController(accountId)).toBeNull();
  });
});
