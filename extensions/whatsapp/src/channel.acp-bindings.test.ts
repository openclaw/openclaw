import { resolveConfiguredAcpBindingRecord } from "openclaw/plugin-sdk/acp-binding-resolve-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { whatsappPlugin } from "./channel.js";

function createCfg(peerId: string, peerKind: "direct" | "group"): OpenClawConfig {
  const runtime = {
    type: "acp",
    acp: { agent: "codex", backend: "acpx", cwd: "/workspace/sandboxed-agent", mode: "oneshot" },
  };
  return {
    agents: { entries: { "sandboxed-agent": { runtime } } },
    bindings: [
      {
        type: "acp",
        agentId: "sandboxed-agent",
        match: {
          channel: "whatsapp",
          accountId: "work",
          peer: { kind: peerKind, id: peerId },
        },
      },
    ],
  } as OpenClawConfig;
}

describe("WhatsApp configured ACP bindings", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "whatsapp", source: "test", plugin: whatsappPlugin }]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each([
    { kind: "direct", peer: "+15551234567", inbound: "15551234567@s.whatsapp.net" },
    {
      kind: "group",
      peer: "120363001234567890@g.us",
      inbound: "whatsapp:group:120363001234567890@g.us",
    },
  ] as const)(
    "materializes $kind WhatsApp ACP bindings from inbound JIDs",
    ({ kind, peer, inbound }) => {
      const resolved = resolveConfiguredAcpBindingRecord({
        cfg: createCfg(peer, kind),
        channel: "whatsapp",
        accountId: "work",
        conversationId: inbound,
      });

      expect(resolved?.spec).toMatchObject({
        channel: "whatsapp",
        accountId: "work",
        conversationId: peer,
        agentId: "sandboxed-agent",
        mode: "oneshot",
        backend: "acpx",
      });
      expect(resolved?.record.conversation.conversationId).toBe(peer);
      expect(resolved?.record.targetSessionKey).toContain(
        "agent:sandboxed-agent:acp:binding:whatsapp:work:",
      );
    },
  );
});
