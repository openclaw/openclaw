/**
 * Proof for #109025 — Subagent loses sender-scoped tool authorization.
 *
 * Run: node scripts/run-vitest.mjs src/agents/proof-109025-sender-tool-policy.test.ts --run
 *
 * Demonstrates:
 * 1. WhatsApp E164 sender → exact toolsBySender allow:["*"] (no denies)
 * 2. Anonymous user (no sender) → wildcard deny:["exec","process","fs_read","fs_write"]
 * 3. Subagent session (spawned) → senderPolicy is undefined (skipped)
 */

import { describe, expect, it } from "vitest";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";

const CONFIG: Record<string, unknown> = {
  tools: {
    toolsBySender: {
      "e164:+1234567890": { allow: ["*"] },
      "*": { deny: ["exec", "process", "fs_read", "fs_write"] },
    },
  },
};

describe("fix #109025: sender-scoped tool policy for subagents", () => {
  it("whatsapp parent with E164 identity gets exact allow override", () => {
    const profile = resolveConversationCapabilityProfile({
      config: CONFIG,
      sessionKey: "main",
      chatType: "direct",
      messageProvider: "whatsapp",
      senderE164: "+1234567890",
      senderIsOwner: false,
    });
    // Parent with E164 identity → gets allow:["*"] (deny is empty)
    expect(profile.policy.senderPolicy).toBeDefined();
    expect(profile.policy.senderPolicy!.deny ?? []).toHaveLength(0);
  });

  it("anonymous user without sender identity gets wildcard deny", () => {
    const profile = resolveConversationCapabilityProfile({
      config: CONFIG,
      sessionKey: "main",
      chatType: "direct",
      messageProvider: "whatsapp",
      senderIsOwner: false,
    });
    expect(profile.policy.senderPolicy).toBeDefined();
    expect(profile.policy.senderPolicy!.deny).toContain("exec");
    expect(profile.policy.senderPolicy!.deny).toContain("fs_read");
  });

  it("spawned subagent skips sender policy (isSubagentEnvelopeSession detected)", () => {
    const profile = resolveConversationCapabilityProfile({
      config: CONFIG,
      sessionKey: "subagent:child::main",
      sandboxSessionKey: "subagent:child::main",
      chatType: "direct",
      messageProvider: "whatsapp",
      senderE164: "+1234567890",
      senderIsOwner: false,
      spawnedBy: "main",
    });
    // Subagent detected via isSubagentEnvelopeSession → sender policy skipped
    expect(profile.policy.senderPolicy).toBeUndefined();
  });
});
