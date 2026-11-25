import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setPluginToolMeta } from "../../plugins/tool-metadata.js";
import { prepareConversationCapabilityProfile } from "../conversation-capability-profile.js";
import type { AnyAgentTool } from "../tools/common.js";
import { applyFinalEffectiveToolPolicy } from "./effective-tool-policy.js";

type ConversationCapabilityProfileParams = Parameters<
  typeof prepareConversationCapabilityProfile
>[0];

function makeTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  };
}

async function applyFinalPolicy(
  params: {
    bundledTools: AnyAgentTool[];
    config?: OpenClawConfig;
    warn?: (message: string) => void;
  } & Pick<
    ConversationCapabilityProfileParams,
    "sessionKey" | "messageProvider" | "senderId" | "groupId" | "groupChannel"
  >,
): Promise<AnyAgentTool[]> {
  const { bundledTools, config, warn, ...profileParams } = params;
  return applyFinalEffectiveToolPolicy({
    bundledTools,
    config,
    conversationCapabilityProfile: await prepareConversationCapabilityProfile({
      config,
      ...profileParams,
    }),
    warn: warn ?? (() => {}),
  });
}

function pluginTool(name = "bundleProbe__bundle_probe") {
  const tool = makeTool(name);
  setPluginToolMeta(tool, { pluginId: "bundle-mcp", optional: false });
  return tool;
}

async function warningsFor(
  params: Omit<Parameters<typeof applyFinalPolicy>[0], "bundledTools" | "warn">,
) {
  const warnings: string[] = [];
  await applyFinalPolicy({
    bundledTools: [makeTool("mcp__bundle__read")],
    ...params,
    warn: (message) => warnings.push(message),
  });
  return warnings;
}

describe("applyFinalEffectiveToolPolicy", () => {
  it("honors configured plugin allow entries alongside inherited bundled tool allows", async () => {
    const agentId = `bundled-plugin-allow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const sessionKey = `agent:${agentId}:subagent:limited`;
    const storePath = path.join(
      os.tmpdir(),
      `openclaw-bundled-plugin-allow-${agentId}`,
      "agents",
      agentId,
      "sessions",
      "sessions.json",
    );
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "limited-session",
        updatedAt: Date.now(),
        spawnDepth: 1,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        inheritedToolAllow: ["mcp__bundle__fs_read"],
      },
    );
    const filtered = await applyFinalPolicy({
      bundledTools: [pluginTool("mcp__bundle__fs_delete"), pluginTool("mcp__bundle__fs_read")],
      config: {
        session: { store: storePath },
        tools: { subagents: { tools: { allow: ["bundle-mcp"] } } },
      },
      sessionKey,
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["mcp__bundle__fs_read"]);
  });

  it("applies channel-normalized per-sender policy to bundled tools", async () => {
    const filtered = await applyFinalPolicy({
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
    });

    expect(filtered.map((tool) => tool.name)).toEqual(["mcp__bundle__read"]);
  });

  it("returns the empty array unchanged when there are no bundled tools", async () => {
    const filtered = await applyFinalPolicy({
      bundledTools: [],
      config: { tools: { allow: ["message"] } },
    });

    expect(filtered).toStrictEqual([]);
  });

  it.each(["agent:alice:discord:group:111", "agent:alice:main"])(
    "drops caller-provided group metadata absent from session %s (fail-closed)",
    async (sessionKey) => {
      const warnings = await warningsFor({
        sessionKey,
        groupId: "admin-group",
        groupChannel: "#admin",
      });

      expect(warnings).toContain(
        "effective tool policy: dropping caller-provided groupId that does not match session-derived group context",
      );
    },
  );

  it("does not emit unknown-entry warnings for core tool allowlists in the bundled pass", async () => {
    const warnings = await warningsFor({
      config: { tools: { allow: ["read", "exec", "mcp__bundle__read"] } },
    });

    expect(warnings.filter((message) => message.includes("unknown entries"))).toStrictEqual([]);
  });

  it("still warns on genuinely unknown entries in the bundled pass", async () => {
    const warnings = await warningsFor({
      config: { tools: { allow: ["mcp__bundle__read", "totally-made-up-tool"] } },
    });

    expect(warnings.filter((message) => message.includes("totally-made-up-tool"))).toHaveLength(1);
  });

  it.each([
    { deny: undefined, expected: ["bundleProbe__bundle_probe"] },
    { deny: ["bundle-mcp"], expected: [] },
  ])("applies the coding profile plugin allowlist with deny=$deny", async ({ deny, expected }) => {
    const filtered = await applyFinalPolicy({
      bundledTools: [pluginTool()],
      config: { tools: { profile: "coding", deny } },
    });

    expect(filtered.map((tool) => tool.name)).toEqual(expected);
  });
});
