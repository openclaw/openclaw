import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveGroupToolPolicyOutcome,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "./agent-tools.policy.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";

vi.mock("../channels/plugins/session-conversation.js", () => ({
  resolveSessionConversation: ({ rawId }: { rawId: string }) => ({
    id: rawId,
    threadId: undefined,
    baseConversationId: rawId,
    parentConversationCandidates: [],
  }),
}));
vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: () => ({
    config: {
      listAccountIds: (config: OpenClawConfig) => [
        "default",
        ...Object.keys(config.channels?.whatsapp?.accounts ?? {}),
      ],
    },
  }),
}));

async function storedSession(
  entry: Partial<SessionEntry>,
  config: OpenClawConfig = {},
  sessionKey = "agent:main:subagent:limited",
) {
  const store = path.join(
    os.tmpdir(),
    `openclaw-policy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    "agents/main/sessions/sessions.json",
  );
  await replaceSessionEntry(
    { sessionKey, storePath: store },
    { sessionId: "limited", updatedAt: Date.now(), ...entry },
  );
  return { config: { ...config, session: { store } }, sessionKey };
}

describe("resolveGroupToolPolicy group context validation", () => {
  const config: OpenClawConfig = {
    channels: {
      whatsapp: {
        groups: {
          "safe-room": { tools: { allow: ["read"] } },
          "trusted-group": { tools: { allow: ["exec", "read", "write", "edit"] } },
          room: { tools: { allow: ["exec", "read"] } },
          "room:sender:alice": { tools: { allow: ["read"] } },
        },
      },
    },
    tools: { allow: ["read"] },
  };
  function groupPolicy(params: Omit<Parameters<typeof resolveGroupToolPolicy>[0], "config">) {
    return resolveGroupToolPolicy({ config, messageProvider: "whatsapp", ...params });
  }

  it("rejects forged groupId when the session has no group context", () => {
    expect(
      groupPolicy({ sessionKey: "agent:main:main", groupId: "trusted-group" }),
    ).toBeUndefined();
  });

  it("uses session-derived group policy when caller groupId disagrees", () => {
    expect(
      groupPolicy({
        sessionKey: "agent:main:whatsapp:group:safe-room",
        groupId: "trusted-group",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("accepts caller groupId when spawnedBy provides the trusted group context", () => {
    expect(
      groupPolicy({
        sessionKey: "agent:main:main",
        spawnedBy: "agent:main:whatsapp:group:trusted-group",
        groupId: "trusted-group",
      }),
    ).toEqual({ allow: ["exec", "read", "write", "edit"] });
  });

  it("keeps specific session group policy ahead of trusted parent caller groupId", () => {
    expect(
      groupPolicy({
        sessionKey: "agent:main:whatsapp:group:room:sender:alice",
        groupId: "room",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("prefers the session-derived channel over caller-supplied messageProvider", () => {
    const channelCfg = {
      channels: {
        discord: { groups: { C123: { tools: { allow: ["exec"] } } } },
        slack: { groups: { C123: { tools: { allow: ["read"] } } } },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolveGroupToolPolicy({
        config: channelCfg,
        sessionKey: "agent:main:slack:group:C123",
        messageProvider: "discord",
        groupId: "C123",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it.each(["agent:main:whatsapp:group:safe-room", "agent:main:main"])(
    "reports unavailable scheduled authority for %s before tool construction",
    (sessionKey) => {
      const params = { config, sessionKey, accountId: "removed", requireConfiguredAccount: true };
      expect(resolveGroupToolPolicyOutcome(params)).toMatchObject({
        kind: "account-unavailable",
        accountId: "removed",
        message: expect.stringContaining('Scheduled account "removed" is unavailable'),
      });
      expect(() => resolveGroupToolPolicy(params)).toThrow(
        'Scheduled account "removed" is unavailable',
      );
    },
  );

  it("preserves intentional deny-all policy for a configured scheduled account", () => {
    expect(
      resolveGroupToolPolicyOutcome({
        config: {
          channels: {
            whatsapp: {
              accounts: { work: {} },
              groups: { "safe-room": { tools: { deny: ["*"] } } },
            },
          },
        },
        sessionKey: "agent:main:whatsapp:group:safe-room",
        accountId: "work",
        requireConfiguredAccount: true,
      }),
    ).toMatchObject({ kind: "resolved", policy: { deny: ["*"] } });
  });
});

describe("stored subagent tool policies", () => {
  it("recomputes a persisted leaf as an orchestrator under the recursive default", async () => {
    const { config, sessionKey } = await storedSession({
      spawnDepth: 1,
      subagentRole: "leaf",
      subagentControlScope: "none",
    });
    const policy = resolveSubagentToolPolicyForSession(config, sessionKey);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(true);
  });

  it("keeps flat depth-1 sessions as leaves under an explicit finite cap", async () => {
    const { config, sessionKey } = await storedSession(
      { spawnDepth: 1, subagentRole: "leaf", subagentControlScope: "none" },
      { agents: { defaults: { subagents: { maxSpawnDepth: 1 } } } },
    );
    const policy = resolveSubagentToolPolicyForSession(config, sessionKey);
    expect(isToolAllowedByPolicyName("gateway", policy)).toBe(false);
    for (const tool of ["sessions_spawn", "subagents", "sessions_search"]) {
      expect(isToolAllowedByPolicyName(tool, policy), tool).toBe(false);
    }
    for (const tool of ["memory_search", "memory_get"]) {
      expect(isToolAllowedByPolicyName(tool, policy), tool).toBe(true);
    }
  });

  it("does not let configured allow entries re-enable hard-denied tools", async () => {
    const denied = [
      "gateway",
      "agents_list",
      "openclaw",
      "session_status",
      "progress_card",
      "automations",
      "cron",
      "message",
      "sessions_send",
      "conversations_list",
      "conversations_send",
      "conversations_turn",
    ];
    const { config, sessionKey } = await storedSession(
      { spawnDepth: 1, subagentRole: "orchestrator", subagentControlScope: "children" },
      { tools: { subagents: { tools: { allow: [...denied, "memory_search"] } } } },
    );
    const policy = resolveSubagentToolPolicyForSession(config, sessionKey);
    for (const tool of denied) {
      expect(isToolAllowedByPolicyName(tool, policy), tool).toBe(false);
    }
    expect(isToolAllowedByPolicyName("memory_search", policy)).toBe(true);
  });

  it("applies inherited tool policy from stored ACP sessions without subagent metadata", async () => {
    const { config, sessionKey } = await storedSession(
      { inheritedToolAllow: ["custom_plugin_tool"], inheritedToolDeny: ["custom_denied_tool"] },
      {},
      "agent:main:acp:limited",
    );
    const policy = resolveInheritedToolPolicyForSession(config, sessionKey);
    expect(isToolAllowedByPolicyName("custom_plugin_tool", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("custom_denied_tool", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("read", policy)).toBe(false);
  });
});

describe("resolveEffectiveToolPolicy", () => {
  it("applies implicit-main defaults tool restrictions to a pre-roster config", () => {
    const config = {
      agents: { defaults: { tools: { deny: ["exec"] } } },
    } as unknown as OpenClawConfig;
    expect(resolveEffectiveToolPolicy({ config })).toMatchObject({
      agentId: "main",
      agentPolicy: { deny: ["exec"] },
    });
  });

  it("does not implicitly re-expose tools from configured sections (#47487)", () => {
    const config: OpenClawConfig = {
      tools: { profile: "messaging", exec: { host: "sandbox" }, fs: { workspaceOnly: false } },
    };
    expect(resolveEffectiveToolPolicy({ config }).profileAlsoAllow).toBeUndefined();
  });

  it("does not warn an agent profile about inherited global tool sections (#47487)", async () => {
    const logs = createWarnLogCapture("openclaw-agent-tools-policy-test");
    try {
      const config: OpenClawConfig = {
        tools: { exec: { mode: "allowlist" }, fs: { workspaceOnly: true } },
        agents: {
          entries: { sage: { tools: { profile: "messaging", alsoAllow: ["view_image"] } } },
        },
      };
      expect(resolveEffectiveToolPolicy({ config, agentId: "sage" }).profileAlsoAllow).toEqual([
        "view_image",
      ]);
      expect(await logs.findText('tools policy: profile "messaging"')).toBeUndefined();
    } finally {
      logs.cleanup();
    }
  });

  it.each<{ name: string; tools: OpenClawConfig["tools"]; warning?: string }>([
    { name: "provider wildcard deny", tools: { byProvider: { fixture: { deny: ["pro*"] } } } },
    { name: "provider profile", tools: { byProvider: { fixture: { profile: "minimal" } } } },
    {
      name: "provider profile alsoAllow",
      tools: { byProvider: { fixture: { profile: "minimal", alsoAllow: ["process"] } } },
      warning: 'Add alsoAllow: ["process"]',
    },
  ])("warns only about actionable grants with $name", async ({ tools, warning }) => {
    const logs = createWarnLogCapture("openclaw-agent-tools-policy-test");
    try {
      const result = resolveEffectiveToolPolicy({
        config: {
          tools,
          agents: {
            entries: {
              ops: {
                tools: { profile: "messaging", alsoAllow: ["exec"], exec: { host: "gateway" } },
              },
            },
          },
        },
        agentId: "ops",
        modelProvider: "fixture",
      });
      const logged = await logs.findText('tools policy: profile "messaging"');
      if (warning) {
        expect(logged).toContain(warning);
      } else {
        expect(logged).toBeUndefined();
      }
      expect(result.profileAlsoAllow).toEqual(["exec"]);
    } finally {
      logs.cleanup();
    }
  });
});
