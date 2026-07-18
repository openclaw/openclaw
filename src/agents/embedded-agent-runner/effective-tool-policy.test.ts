// Coverage for final bundled-tool policy filtering in embedded runs.
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setPluginToolMeta } from "../../plugins/tools.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import type { AnyAgentTool } from "../tools/common.js";
import { applyFinalEffectiveToolPolicy } from "./effective-tool-policy.js";

type ConversationCapabilityProfileParams = Parameters<
  typeof resolveConversationCapabilityProfile
>[0];

function makeTool(name: string): AnyAgentTool {
  // Minimal tool shape keeps policy tests independent from executor/runtime
  // implementations while still exercising plugin metadata.
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  };
}

// Mirrors the production composition: resolve the conversation capability
// profile from server-verified inputs, then apply the final bundled pass.
function applyFinalPolicy(
  params: {
    bundledTools: AnyAgentTool[];
    config?: OpenClawConfig;
    warn?: (message: string) => void;
  } & Pick<
    ConversationCapabilityProfileParams,
    | "sessionKey"
    | "messageProvider"
    | "senderId"
    | "groupId"
    | "groupChannel"
    | "senderE164"
    | "senderIsOwner"
    | "sandboxSessionKey"
    | "spawnedBy"
    | "senderName"
    | "senderUsername"
  >,
): AnyAgentTool[] {
  const { bundledTools, config, warn, ...profileParams } = params;
  return applyFinalEffectiveToolPolicy({
    bundledTools,
    config,
    conversationCapabilityProfile: resolveConversationCapabilityProfile({
      config,
      ...profileParams,
    }),
    warn: warn ?? (() => {}),
  });
}

async function writeSessionEntries(
  storePath: string,
  entries: Record<string, unknown>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ sessionKey, storePath }, entry as SessionEntry);
  }
}

function createSessionStorePath(prefix: string, agentId: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${agentId}`,
    "agents",
    agentId,
    "sessions",
    "sessions.json",
  );
}

describe("applyFinalEffectiveToolPolicy", () => {
  it("filters bundled tools through the configured allowlist", () => {
    const filtered = applyFinalPolicy({
      bundledTools: [makeTool("mcp__bundle__fs_delete"), makeTool("mcp__bundle__fs_read")],
      config: { tools: { allow: ["mcp__bundle__fs_read"] } },
      warn: () => {},
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["mcp__bundle__fs_read"]);
  });

  it("filters bundled tools through inherited subagent allowlists", async () => {
    // Inherited allowlists are persisted by session key; use a real temp store
    // so parsing and lookup match production policy application.
    const agentId = `bundled-inherited-allow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const sessionKey = `agent:${agentId}:subagent:limited`;
    const storePath = createSessionStorePath("openclaw-bundled-inherited-allow", agentId);
    await writeSessionEntries(storePath, {
      [sessionKey]: {
        sessionId: "limited-session",
        updatedAt: Date.now(),
        spawnDepth: 1,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        inheritedToolAllow: ["mcp__bundle__fs_read"],
      },
    });

    const filtered = applyFinalPolicy({
      bundledTools: [makeTool("mcp__bundle__fs_delete"), makeTool("mcp__bundle__fs_read")],
      config: {
        session: {
          store: storePath,
        },
      },
      sessionKey,
      warn: () => {},
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["mcp__bundle__fs_read"]);
  });

  it("honors configured plugin allow entries alongside inherited bundled tool allows", async () => {
    const agentId = `bundled-plugin-allow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const sessionKey = `agent:${agentId}:subagent:limited`;
    const storePath = createSessionStorePath("openclaw-bundled-plugin-allow", agentId);
    await writeSessionEntries(storePath, {
      [sessionKey]: {
        sessionId: "limited-session",
        updatedAt: Date.now(),
        spawnDepth: 1,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        inheritedToolAllow: ["mcp__bundle__fs_read"],
      },
    });
    const deniedTool = makeTool("mcp__bundle__fs_delete");
    const allowedTool = makeTool("mcp__bundle__fs_read");
    setPluginToolMeta(deniedTool, { pluginId: "bundle-mcp", optional: false });
    setPluginToolMeta(allowedTool, { pluginId: "bundle-mcp", optional: false });

    const filtered = applyFinalPolicy({
      bundledTools: [deniedTool, allowedTool],
      config: {
        session: {
          store: storePath,
        },
        tools: {
          subagents: {
            tools: {
              allow: ["bundle-mcp"],
            },
          },
        },
      },
      sessionKey,
      warn: () => {},
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["mcp__bundle__fs_read"]);
  });

  it("applies channel-normalized per-sender policy to bundled tools", () => {
    // Teams normalizes to msteams in policy keys, which must happen before
    // sender-specific deny rules are applied.
    const filtered = applyFinalPolicy({
      bundledTools: [makeTool("mcp__bundle__exec"), makeTool("mcp__bundle__read")],
      config: {
        tools: {
          toolsBySender: {
            "channel:msteams:alice": { deny: ["mcp__bundle__exec"] },
          },
        },
      },
      messageProvider: "teams",
      senderId: "alice",
      warn: () => {},
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["mcp__bundle__read"]);
  });

  it("returns the empty array unchanged when there are no bundled tools", () => {
    const filtered = applyFinalPolicy({
      bundledTools: [],
      config: { tools: { allow: ["message"] } },
      warn: () => {},
    });

    expect(filtered).toStrictEqual([]);
  });

  it("drops caller-provided groupId when it disagrees with session-derived group context", () => {
    const warnings: string[] = [];
    applyFinalPolicy({
      bundledTools: [makeTool("mcp__bundle__read")],
      // Session key encodes a concrete group (discord room 111); caller tries
      // to override with a different group id so a more permissive group
      // policy for group 222 could be consulted.
      sessionKey: "agent:alice:discord:group:111",
      groupId: "222",
      groupChannel: "#different",
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toContain(
      "effective tool policy: dropping caller-provided groupId that does not match session-derived group context",
    );
  });

  it("drops caller-provided groupId when session encodes no group context (fail-closed)", () => {
    const warnings: string[] = [];
    applyFinalPolicy({
      bundledTools: [makeTool("mcp__bundle__read")],
      // Direct/non-group session key: no session-derived group ids. A caller
      // supplying a groupId here has no server-verified ground truth; it
      // must be dropped so a spoofed group cannot reach a permissive policy.
      sessionKey: "agent:alice:main",
      groupId: "admin-group",
      groupChannel: "#admin",
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toContain(
      "effective tool policy: dropping caller-provided groupId that does not match session-derived group context",
    );
  });

  it("leaves groupId untouched when caller did not supply one", () => {
    const warnings: string[] = [];
    applyFinalPolicy({
      bundledTools: [makeTool("mcp__bundle__read")],
      sessionKey: "agent:alice:main",
      warn: (message) => warnings.push(message),
    });

    expect(warnings).not.toContain(
      "effective tool policy: dropping caller-provided groupId that does not match session-derived group context",
    );
  });

  it("does not emit unknown-entry warnings for core tool allowlists in the bundled pass", () => {
    const warnings: string[] = [];
    applyFinalPolicy({
      bundledTools: [makeTool("mcp__bundle__read")],
      // Core tool names like `read` and `exec` are not in the bundled-only
      // input here, but they are valid core tools resolved by the first
      // pass. The bundled pass must not warn about them as "unknown".
      config: { tools: { allow: ["read", "exec", "mcp__bundle__read"] } },
      warn: (message) => warnings.push(message),
    });

    expect(warnings.filter((message) => message.includes("unknown entries"))).toStrictEqual([]);
  });

  it("still warns on genuinely unknown entries in the bundled pass", () => {
    const warnings: string[] = [];
    applyFinalPolicy({
      bundledTools: [makeTool("mcp__bundle__read")],
      config: { tools: { allow: ["mcp__bundle__read", "totally-made-up-tool"] } },
      warn: (message) => warnings.push(message),
    });

    expect(warnings.filter((message) => message.includes("totally-made-up-tool"))).toHaveLength(1);
  });

  it("keeps bundle MCP tools in the coding profile via plugin metadata", () => {
    const mcpTool = makeTool("bundleProbe__bundle_probe");
    setPluginToolMeta(mcpTool, { pluginId: "bundle-mcp", optional: false });

    const filtered = applyFinalPolicy({
      bundledTools: [mcpTool],
      config: { tools: { profile: "coding" } },
      warn: () => {},
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
  });

  it("lets explicit deny entries override the profile bundle MCP allowlist", () => {
    const mcpTool = makeTool("bundleProbe__bundle_probe");
    setPluginToolMeta(mcpTool, { pluginId: "bundle-mcp", optional: false });

    const filtered = applyFinalPolicy({
      bundledTools: [mcpTool],
      config: { tools: { profile: "coding", deny: ["bundle-mcp"] } },
      warn: () => {},
    });

    expect(filtered).toStrictEqual([]);
  });

  // ──  fix #109025: sender-scoped tool policy for subagents  ──────────────
  //
  //  A spawned subagent has no external sender identity, so
  //  `resolveSenderToolPolicy` would fall through all exact sender matchers
  //  and return the wildcard "*" entry, stripping filesystem/runtime tools.
  //  The fix skips sender-policy resolution for recognized subagent
  //  envelopes (`isSubagentEnvelopeSession`), letting the child inherit the
  //  parent's already-resolved policy. Subagent restrictions are still
  //  applied independently so the final clamp is preserved.
  //
  //  1. Parent with exact E164 identity   → all tools pass sender policy
  //  2. Anonymous user (no sender fields)  → wildcard deny strips tools
  //  3. Spawned subagent from E164 parent  → senderPolicy skipped, subagent
  //     restrictions still narrow the final inventory
  //  4. Spawned subagent without subagent  → subagent restrictions still
  //     restrict (inherited allowlist applies on top)

  it("fix #109025: parent with E164 gets exact toolsBySender allow (no denies)", () => {
    // WhatsApp parent with E164 → exact allow override, no wildcard denies
    const filtered = applyFinalPolicy({
      bundledTools: [makeTool("exec"), makeTool("fs_read"), makeTool("message")],
      config: {
        tools: {
          toolsBySender: {
            "e164:+1234567890": { allow: ["*"] },
            "*": { deny: ["exec", "process", "fs_read", "fs_write"] },
          },
        },
      },
      sessionKey: "main",
      messageProvider: "whatsapp",
      senderE164: "+1234567890",
      senderIsOwner: false,
      warn: () => {},
    });

    // Parent keeps all tools — wildcard deny is not applied
    expect(filtered.map((t) => t.name)).toEqual(
      expect.arrayContaining(["exec", "fs_read", "message"]),
    );
  });

  it("fix #109025: anonymous user without sender identity gets wildcard deny", () => {
    // No sender fields → wildcard deny applies, stripping fs/runtime tools
    const filtered = applyFinalPolicy({
      bundledTools: [makeTool("exec"), makeTool("fs_read"), makeTool("message")],
      config: {
        tools: {
          toolsBySender: {
            "e164:+1234567890": { allow: ["*"] },
            "*": { deny: ["exec", "process", "fs_read", "fs_write"] },
          },
        },
      },
      sessionKey: "main",
      messageProvider: "whatsapp",
      senderIsOwner: false,
      warn: () => {},
    });

    expect(filtered.map((t) => t.name)).toEqual(["message"]);
  });

  it("fix #109025: spawned subagent skips sender policy, retains parent tools", () => {
    // Subagent with subagent session key → isSubagentEnvelopeSession
    // detected → senderPolicy = undefined (skipped), so exec/fs_read survive
    // the sender-policy step. Subagent restrictions still apply but nothing
    // is configured here, so all tools pass.
    const filtered = applyFinalPolicy({
      bundledTools: [makeTool("exec"), makeTool("fs_read"), makeTool("message")],
      config: {
        tools: {
          toolsBySender: {
            "e164:+1234567890": { allow: ["*"] },
            "*": { deny: ["exec", "process", "fs_read", "fs_write"] },
          },
        },
      },
      sessionKey: "subagent:child::main",
      sandboxSessionKey: "subagent:child::main",
      spawnedBy: "main",
      messageProvider: "whatsapp",
      senderE164: "+1234567890",
      senderIsOwner: false,
      warn: () => {},
    });

    // Subagent inherits parent's tools via senderPolicy skip
    expect(filtered.map((t) => t.name)).toEqual(
      expect.arrayContaining(["exec", "fs_read", "message"]),
    );
  });

  it("fix #109025: subagent restrictions still narrow tools after sender-policy skip", () => {
    // Subagent skips sender policy (retains parent tools), but
    // subagent tools.deny still removes the configured restricted tools.
    const filtered = applyFinalPolicy({
      bundledTools: [
        makeTool("exec"),
        makeTool("fs_read"),
        makeTool("fs_write"),
        makeTool("message"),
      ],
      config: {
        tools: {
          toolsBySender: {
            "e164:+1234567890": { allow: ["*"] },
            "*": { deny: ["exec", "process", "fs_read", "fs_write"] },
          },
          subagents: {
            tools: {
              deny: ["fs_write"],
            },
          },
        },
      },
      sessionKey: "subagent:child::main",
      sandboxSessionKey: "subagent:child::main",
      spawnedBy: "main",
      messageProvider: "whatsapp",
      senderE164: "+1234567890",
      senderIsOwner: false,
      warn: () => {},
    });

    // Subagent retains exec and fs_read (sender policy skipped), but
    // fs_write is removed by the subagent restriction layer
    expect(filtered.map((t) => t.name)).toEqual(
      expect.arrayContaining(["exec", "fs_read", "message"]),
    );
    expect(filtered.map((t) => t.name)).not.toContain("fs_write");
  });
});
