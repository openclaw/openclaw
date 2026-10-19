import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronScheduledToolCallerOrigin } from "../cron/scheduled-tool-policy.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import {
  prepareConversationCapabilityProfile,
  resolveConversationCapabilityProfile as resolveProfile,
} from "./conversation-capability-profile.js";
import {
  isConversationToolAllowed as allows,
  projectConversationToolNames,
} from "./conversation-tool-policy-pipeline.js";
import { preparePluginHarnessPolicyToolsAllow } from "./harness/execution-environment.js";
import type { ScheduledToolPolicyContext } from "./scheduled-tool-policy.js";
import { resolveWebSearchToolPolicy } from "./web-search-tool-policy.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-capability-profile-");
const readWrite = ["read", "write"];
const runtimeTools = ["sessions_spawn", "memory_search"];

type Profile = ReturnType<typeof resolveProfile>;
function project(capabilityProfile: Profile, toolNames: string[]) {
  return projectConversationToolNames({ capabilityProfile, toolNames, warn: () => undefined });
}
function expectPolicy(profile: Profile, expected: Partial<Profile["policy"]>) {
  expect(profile.policy).toEqual(expect.objectContaining(expected));
}
function groupConfig(
  toolsBySender: Record<string, { allow?: string[]; deny?: string[] }>,
  allow = ["read"],
): OpenClawConfig {
  return { channels: { whatsapp: { groups: { team: { tools: { allow }, toolsBySender } } } } };
}

describe("resolveConversationCapabilityProfile", () => {
  it.each(["fixture-reader", "group:plugins"])("requires registered ownership for %s", (allow) => {
    const profile = resolveProfile({ config: { tools: { allow: [allow, "read"] } } });
    expect(allows(profile, "read_public_item", { pluginId: "fixture-reader" })).toBe(true);
    expect(allows(profile, "read_public_item")).toBe(false);
    expect(allows(profile, "read")).toBe(true);
  });

  it.each(["read_public_item", "fixture-reader", "group:plugins"])(
    "rechecks %s denies on registered tools",
    (deny) => {
      const profile = resolveProfile({
        config: { tools: { allow: ["group:plugins"], deny: [deny] } },
      });
      expect(allows(profile, "read_public_item", { pluginId: "fixture-reader" })).toBe(false);
    },
  );

  it("does not let plugin ownership widen a narrower conversation policy", () => {
    const profile = resolveProfile({
      config: { tools: { allow: ["group:plugins", "read"] } },
      conversationToolPolicy: { allow: ["read"] },
    });
    expect(allows(profile, "read_public_item", { pluginId: "fixture-reader" })).toBe(false);
    expect(allows(profile, "read")).toBe(true);
  });

  it("intersects base and provider profile contributions from plugin manifests", () => {
    const profile = resolveProfile({
      config: { tools: { profile: "coding", byProvider: { openai: { profile: "messaging" } } } },
      modelProvider: "openai",
      pluginMetadataSnapshot: {
        plugins: [
          {
            contracts: { tools: ["coding_only", "messaging_only", "shared"] },
            toolMetadata: {
              coding_only: { profiles: ["coding"] },
              messaging_only: { profiles: ["messaging"] },
              shared: { profiles: ["coding", "messaging"] },
            },
          },
        ],
      } as never,
    });
    expect(project(profile, ["coding_only", "messaging_only", "shared"])).toEqual(["shared"]);
  });

  it("intersects a prepared direct policy with existing tool policy", () => {
    const profile = resolveProfile({
      config: { tools: { deny: ["write"] } },
      conversationToolPolicy: { allow: ["read", "write", "exec"], deny: ["exec"] },
    });
    expect(profile.policy.groupPolicy).toEqual({
      allow: ["read", "write", "exec"],
      deny: ["exec"],
    });
    expect(profile.policy.inheritancePolicies).toContain(profile.policy.groupPolicy);
    expect(project(profile, ["read", "write", "exec", "process"])).toEqual(["read"]);
  });

  it("does not add a requester restriction without a conversation policy", () => {
    const profile = resolveProfile({});
    expect(profile.policy.groupPolicy).toBeUndefined();
    expect(project(profile, ["read", "write", "exec"])).toEqual(["read", "write", "exec"]);
  });

  it.each([
    [{ messageChannel: INTERNAL_MESSAGE_CHANNEL, senderIsOwner: true }, false],
    [{ messageProvider: INTERNAL_MESSAGE_CHANNEL, senderIsOwner: false }, true],
    [{ messageProvider: "discord", senderIsOwner: true }, true],
  ] as const)("applies sender restrictions for %j", (params, restricted) => {
    const deny = ["exec", "process"];
    const profile = resolveProfile({
      config: { tools: { toolsBySender: { "*": { deny } } } },
      ...params,
    });
    expectPolicy(profile, {
      senderPolicy: restricted ? { deny } : undefined,
      explicitToolDenylist: restricted ? deny : [],
    });
  });

  it("prepares a shared conversation profile with group per-sender restrictions", () => {
    const profile = resolveProfile({
      config: groupConfig({ "id:alice": { allow: ["read", "exec"] } }),
      sessionKey: "agent:main:whatsapp:group:team",
      agentId: "main",
      messageProvider: "whatsapp",
      groupId: "team",
      senderId: "alice",
    });
    expectPolicy(profile, {
      trustedGroup: { groupId: "team", dropped: false },
      groupPolicy: { allow: ["read", "exec"] },
      explicitToolAllowlist: ["read", "exec"],
    });
  });

  it("uses a scheduled owner group without reapplying sender wildcard policy", () => {
    const cfg: OpenClawConfig = {
      ...groupConfig({ "*": { deny: ["write"] } }, readWrite),
      tools: { deny: ["exec"], toolsBySender: { "*": { deny: ["write"] } } },
    };
    const baseParams = {
      config: cfg,
      sessionKey: "agent:main:cron:job:run:session",
      agentId: "main",
      messageProvider: "whatsapp",
      runtimeToolAllowlist: ["write"],
    };
    const legacy = resolveProfile(baseParams);
    const scheduled = resolveProfile({
      ...baseParams,
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:whatsapp:group:team",
        ownerAccountId: "default",
      },
    });
    expectPolicy(legacy, { senderPolicy: { deny: ["write"] }, groupPolicy: undefined });
    expectPolicy(scheduled, {
      senderPolicy: undefined,
      groupPolicy: { allow: readWrite },
      explicitToolDenylist: ["exec"],
    });
    expect(scheduled.policy.explicitToolAllowlist).toContain("write");
  });

  it("adds runtime tools without replacing the configured tool surface", () => {
    const runtimePluginToolGrant = {
      pluginId: "workboard",
      toolNames: ["workboard_heartbeat", " workboard_complete ", "workboard_heartbeat"],
    };
    const normalized = ["workboard_heartbeat", "workboard_complete"];
    const profile = resolveProfile({
      config: { tools: { profile: "coding", deny: ["workboard_block"] } },
      runtimePluginToolGrant,
    });
    expectPolicy(profile, {
      profileAlsoAllow: normalized,
      providerProfileAlsoAllow: normalized,
      explicitToolOverrideAllowlist: [],
      explicitToolDenylist: ["workboard_block"],
      runtimePluginToolGrant,
    });
    expect(profile.policy.explicitToolAllowlist).toEqual(expect.arrayContaining(["read", "exec"]));
    expect(profile.policy.explicitToolAllowlist).not.toContain("workboard_heartbeat");
    expect(profile.policy.inheritancePolicies).not.toContainEqual({ allow: normalized });
  });

  it("keeps inherited subagent grants out of explicit overrides", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const sessionKey = "agent:main:subagent:limited";
    await replaceSessionEntry({ storePath, sessionKey }, {
      sessionId: "limited-session",
      updatedAt: Date.now(),
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      spawnedBy: "agent:main:main",
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["image_generate"],
    } as SessionEntry);
    const profile = await prepareConversationCapabilityProfile({
      config: { session: { store: storePath } },
      sessionKey,
      agentId: "main",
      modelProvider: "ollama",
      modelId: "qwen3.5:9b",
    });
    expect(profile.policy.explicitToolAllowlist).toContain("image_generate");
    expect(profile.policy.explicitToolOverrideAllowlist).not.toContain("image_generate");
    expect(profile.policy).toMatchObject({
      delegated: true,
      requesterPolicySource: "persisted-child",
    });
  });

  it("keeps runtime allowlists local unless the caller opts into inheritance", () => {
    const local = resolveProfile({ runtimeToolAllowlist: runtimeTools });
    expect(local.policy).toMatchObject({
      explicitToolAllowlist: runtimeTools,
      explicitToolOverrideAllowlist: runtimeTools,
      runtimeToolPolicyForInheritance: undefined,
    });

    const inherited = resolveProfile({
      runtimeToolAllowlist: runtimeTools,
      inheritRuntimeToolAllowlist: true,
    });

    expect(inherited.policy.runtimeToolPolicyForInheritance).toEqual({ allow: runtimeTools });
    expect(inherited.policy.inheritancePolicies).toContain(
      inherited.policy.runtimeToolPolicyForInheritance,
    );
  });

  it("drops caller group facts that the session key cannot vouch for", () => {
    const profile = resolveProfile({
      sessionKey: "agent:main:discord:dm:guest",
      agentId: "main",
      messageProvider: "discord",
      groupId: "team",
      groupChannel: "#general",
      groupSpace: "guild-1",
      senderId: "guest",
    });

    expect(profile.policy.trustedGroup).toEqual({ groupId: null, dropped: true });
    expect(profile.conversation).toMatchObject({
      groupId: null,
      groupChannel: null,
      groupSpace: null,
    });
  });
});

describe("resolveConversationCapabilityProfile scheduled account authority", () => {
  beforeEach(() => {
    const plugin = { id: "whatsapp", meta: {}, config: createAccountListHelpers("whatsapp") };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "whatsapp", source: "test", plugin }]));
  });

  it.each([
    ["external", true, "telegram"],
    ["unknown", true, "whatsapp"],
    ["local", false, "whatsapp"],
  ] satisfies Array<[CronScheduledToolCallerOrigin["kind"], boolean, string]>)(
    "preserves scheduled %s creator authority (configured=%s, delivery=%s)",
    async (origin, configured, delivery) => {
      const config: OpenClawConfig = {
        channels: { whatsapp: { accounts: configured ? { work: {} } : {} } },
      };
      const params = {
        config,
        sessionKey: "agent:main:cron:job:run:turn",
        agentId: "main",
        agentAccountId: "default",
        messageProvider: delivery,
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey:
            origin === "local" ? "agent:main:main" : "agent:main:whatsapp:direct:sender",
          ownerAccountId: "work",
          ownerOrigin:
            origin === "external" ? { kind: origin, channel: "whatsapp" } : { kind: origin },
        } satisfies ScheduledToolPolicyContext,
      };
      const conversationTools = () =>
        project(
          resolveProfile({
            ...params,
            config: { ...params.config, tools: { allow: ["read"] } },
          }),
          ["read", "write"],
        );
      const webSearch = () =>
        resolveWebSearchToolPolicy({ ...params, runtimeToolAllowlist: ["web_search"] });
      const harnessTools = () =>
        preparePluginHarnessPolicyToolsAllow({
          ...params,
          provider: "fixture",
          modelId: "fixture-model",
          senderId: "sender",
          conversationToolPolicy: { deny: ["*"] },
        });

      if (origin === "unknown" || !configured) {
        for (const resolve of [conversationTools, webSearch]) {
          expect(resolve).toThrow('Scheduled account "work" is unavailable');
        }
        await expect(harnessTools()).rejects.toThrow('Scheduled account "work" is unavailable');
        return;
      }
      expect(conversationTools()).toEqual(["read"]);
      expect(webSearch()).toEqual({ allowed: true, persistentAllowed: true });
      expect(await harnessTools()).toEqual([]);
    },
  );
});
