/**
 * Proof for #109025 — Subagent loses sender-scoped tool authorization.
 *
 * Run: node scripts/run-vitest.mjs src/agents/proof-109025-sender-tool-policy.test.ts --run
 *
 * Demonstrates:
 * 1. WhatsApp E164 sender → exact toolsBySender allow:["*"] (no denies)
 * 2. Anonymous user (no sender) → wildcard deny:["exec","process","fs_read","fs_write"]
 * 3. Subagent session with stored inheritedSenderPolicy → uses stored policy
 *    instead of re-resolving, preserving the parent's authorization ceiling.
 */

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
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

  it("spawned subagent with stored inheritedSenderPolicy gets that policy", async () => {
    // Subagent session with stored inheritedSenderPolicy → uses stored policy
    // instead of re-resolving (which would match wildcard "*" with no sender fields).
    const agentId = `proof-subagent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const sessionKey = `agent:${agentId}:subagent:child`;
    const storePath = path.join(
      os.tmpdir(),
      `openclaw-proof-109025-${agentId}`,
      "agents",
      agentId,
      "sessions",
      "sessions.json",
    );
    await replaceSessionEntry({ storePath, sessionKey }, {
      sessionId: "child-session",
      updatedAt: Date.now(),
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedSenderPolicy: { allow: ["*"] },
    } as SessionEntry);

    const profile = resolveConversationCapabilityProfile({
      config: { ...CONFIG, session: { store: storePath } },
      sessionKey,
      sandboxSessionKey: sessionKey,
      chatType: "direct",
      messageProvider: "whatsapp",
      // No sender fields — realistic subagent scenario
      senderIsOwner: false,
      spawnedBy: "main",
    });
    // Subagent gets stored inheritedSenderPolicy instead of wildcard
    expect(profile.policy.senderPolicy).toBeDefined();
    expect(profile.policy.senderPolicy!.allow).toContain("*");
  });
});
