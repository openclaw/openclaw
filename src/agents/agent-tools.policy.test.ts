import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { WhatsAppConfig } from "../config/types.whatsapp.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "./agent-tools.policy.js";
import { withPreparedSessionCapabilityRead } from "./subagents/spawn/subagent-session-store.js";
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

async function storedPolicy(
  entry: Partial<SessionEntry>,
  config: OpenClawConfig = {},
  sessionKey = "agent:main:subagent:limited",
  kind: "subagent" | "inherited" = "subagent",
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
  return withPreparedSessionCapabilityRead(() =>
    (kind === "subagent"
      ? resolveSubagentToolPolicyForSession
      : resolveInheritedToolPolicyForSession)({ ...config, session: { store } }, sessionKey),
  );
}

function expectAllowed(
  policy: Awaited<ReturnType<typeof storedPolicy>>,
  allowed: readonly string[],
  denied: readonly string[] = [],
) {
  for (const [names, expected] of [
    [allowed, true],
    [denied, false],
  ] as const) {
    for (const name of names) {
      expect(isToolAllowedByPolicyName(name, policy), name).toBe(expected);
    }
  }
}

describe("resolveGroupToolPolicy group context validation", () => {
  const whatsapp = (groups: WhatsAppConfig["groups"], accounts?: WhatsAppConfig["accounts"]) => ({
    channels: { whatsapp: { groups, accounts } },
  });
  const config = {
    ...whatsapp({
      "safe-room": { tools: { allow: ["read"] } },
      "trusted-group": { tools: { allow: ["exec", "read", "write", "edit"] } },
      room: { tools: { allow: ["exec", "read"] } },
      "room:sender:alice": { tools: { allow: ["read"] } },
    }),
    tools: { allow: ["read"] },
  };
  function groupPolicy(params: Omit<Parameters<typeof resolveGroupToolPolicy>[0], "config">) {
    return resolveGroupToolPolicy({ config, messageProvider: "whatsapp", ...params });
  }

  it.each([
    ["forged groupId", "main", "trusted-group", undefined, undefined],
    ["session overrides caller", "whatsapp:group:safe-room", "trusted-group", undefined, ["read"]],
    [
      "spawnedBy group",
      "main",
      "trusted-group",
      "agent:main:whatsapp:group:trusted-group",
      ["exec", "read", "write", "edit"],
    ],
    [
      "specific session overrides parent",
      "whatsapp:group:room:sender:alice",
      "room",
      undefined,
      ["read"],
    ],
  ] as const)("%s", (_name, session, groupId, spawnedBy, allow) => {
    expect(groupPolicy({ sessionKey: `agent:main:${session}`, groupId, spawnedBy })).toEqual(
      allow ? { allow } : undefined,
    );
  });

  it("trusts the session channel, not the caller", () => {
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
    "rejects unavailable scheduled authority (%s)",
    (sessionKey) => {
      const params = { config, sessionKey, accountId: "removed", requireConfiguredAccount: true };
      expect(() => resolveGroupToolPolicy(params)).toThrow(
        'Scheduled account "removed" is unavailable',
      );
    },
  );

  it("preserves scheduled deny-all", () => {
    expect(
      resolveGroupToolPolicy({
        config: whatsapp({ "safe-room": { tools: { deny: ["*"] } } }, { work: {} }),
        sessionKey: "agent:main:whatsapp:group:safe-room",
        accountId: "work",
        requireConfiguredAccount: true,
      }),
    ).toEqual({ deny: ["*"] });
  });
});

describe("stored subagent tool policies", () => {
  it.each([
    [undefined, ["sessions_spawn", "subagents"], []],
    [
      1,
      ["memory_search", "memory_get"],
      ["gateway", "sessions_spawn", "subagents", "sessions_search"],
    ],
  ] as const)(
    "recomputes a persisted leaf with depth cap %s",
    async (maxSpawnDepth, allowed, denied) => {
      const policy = await storedPolicy(
        { spawnDepth: 1, subagentRole: "leaf", subagentControlScope: "none" },
        maxSpawnDepth === undefined
          ? {}
          : { agents: { defaults: { subagents: { maxSpawnDepth } } } },
      );
      expectAllowed(policy, allowed, denied);
    },
  );

  it("never re-enables hard-denied tools", async () => {
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
    const policy = await storedPolicy(
      { spawnDepth: 1, subagentRole: "orchestrator", subagentControlScope: "children" },
      { tools: { subagents: { tools: { allow: [...denied, "memory_search"] } } } },
    );
    expectAllowed(policy, ["memory_search"], denied);
  });

  it("inherits ACP policy without subagent metadata", async () => {
    const policy = await storedPolicy(
      { inheritedToolAllow: ["custom_plugin_tool"], inheritedToolDeny: ["custom_denied_tool"] },
      {},
      "agent:main:acp:limited",
      "inherited",
    );
    expectAllowed(policy, ["custom_plugin_tool"], ["custom_denied_tool", "read"]);
  });
});

describe("resolveEffectiveToolPolicy", () => {
  it("applies pre-roster implicit-main defaults", () => {
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

  it("does not warn about a provider wildcard deny", async () => {
    const logs = createWarnLogCapture("openclaw-agent-tools-policy-test");
    try {
      const result = resolveEffectiveToolPolicy({
        config: {
          tools: { byProvider: { fixture: { deny: ["pro*"] } } },
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
      expect(logged).toBeUndefined();
      expect(result.profileAlsoAllow).toEqual(["exec"]);
    } finally {
      logs.cleanup();
    }
  });
});
