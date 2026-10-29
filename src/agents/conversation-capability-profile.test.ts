import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronScheduledToolCallerOrigin } from "../cron/scheduled-tool-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.types.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
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
import {
  preparePluginHarnessToolPolicies,
  resolvePluginHarnessPolicyToolsAllow,
} from "./harness/execution-environment.js";
import type { ScheduledToolPolicyContext } from "./scheduled-tool-policy.js";
import { resolveWebSearchToolPolicy } from "./web-search-tool-policy.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-capability-profile-");
const readWrite = ["read", "write"];
const runtimeTools = ["sessions_spawn", "memory_search"];

type Profile = ReturnType<typeof resolveProfile>;
type ProfileParams = Parameters<typeof resolveProfile>[0];
function project(capabilityProfile: Profile, toolNames = ["read", "write", "exec"]) {
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
const direct = (overrides: ProfileParams = {}): ProfileParams => ({
  sessionKey: "agent:main:main",
  messageProvider: "telegram",
  agentAccountId: "work",
  chatType: "direct",
  conversationId: "42",
  senderId: "alice",
  ...overrides,
});

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

  it("includes every declared Knowledge tool in coding without opening other plugins", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../extensions/knowledge/openclaw.plugin.json", import.meta.url),
        "utf8",
      ),
    ) as {
      contracts: { tools: string[] };
      toolMetadata?: PluginManifestRecord["toolMetadata"];
    };
    const otherTool = "unrelated_plugin_tool";
    const pluginMetadataSnapshot = {
      plugins: [
        createPluginManifestRecordFixture({
          id: "knowledge",
          contracts: manifest.contracts,
          toolMetadata: manifest.toolMetadata,
        }),
        createPluginManifestRecordFixture({ id: "unrelated", contracts: { tools: [otherTool] } }),
      ],
    };
    const names = [...manifest.contracts.tools, otherTool];
    const coding = resolveProfile({
      config: { tools: { profile: "coding" } },
      pluginMetadataSnapshot,
    });
    expect(project(coding, names)).toEqual(manifest.contracts.tools);

    const denied = resolveProfile({
      config: { tools: { profile: "coding", deny: ["knowledge_withdraw"] } },
      pluginMetadataSnapshot,
    });
    expect(project(denied, names)).not.toContain("knowledge_withdraw");
    const messaging = resolveProfile({
      config: { tools: { profile: "messaging" } },
      pluginMetadataSnapshot,
    });
    expect(project(messaging, names)).toEqual([]);
  });

  it("intersects a prepared direct policy with existing tool policy", () => {
    const profile = resolveProfile({
      config: { tools: { deny: ["write"] } },
      conversationToolPolicy: { allow: ["read", "write", "exec"], deny: ["exec"] },
    });
    expect(profile.policy.inheritancePolicies).toContainEqual({
      allow: ["read", "write", "exec"],
      deny: ["exec"],
    });
    expect(project(profile, ["read", "write", "exec", "process"])).toEqual(["read"]);
  });

  it("does not add a requester restriction without a conversation policy", () => {
    const profile = resolveProfile({});
    expect(profile.policy.groupPolicy).toBeUndefined();
    expect(project(profile)).toEqual(["read", "write", "exec"]);
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

  it("normalizes additive runtime tools without making them explicit overrides", () => {
    const runtimePluginToolGrant = {
      pluginId: "workboard",
      toolNames: ["workboard_heartbeat", " workboard_complete ", "workboard_heartbeat"],
    };
    const normalized = ["workboard_heartbeat", "workboard_complete"];
    const profile = resolveProfile({
      config: { tools: { profile: "coding" } },
      runtimePluginToolGrant,
    });
    expectPolicy(profile, {
      profileAlsoAllow: normalized,
      providerProfileAlsoAllow: normalized,
      explicitToolOverrideAllowlist: [],
    });
    expect(profile.policy.explicitToolAllowlist).toEqual(expect.arrayContaining(["read", "exec"]));
    expect(profile.policy.explicitToolAllowlist).not.toContain("workboard_heartbeat");
    expect(profile.policy.inheritancePolicies).not.toContainEqual({ allow: normalized });
  });

  it("keeps inherited subagent grants out of explicit overrides", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const sessionKey = "agent:main:subagent:limited";
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "limited-session",
        updatedAt: Date.now(),
        spawnDepth: 1,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        spawnedBy: "agent:main:main",
        inheritedToolPolicyVersion: 1,
        inheritedToolAllow: ["image_generate"],
      },
    );
    const profile = await prepareConversationCapabilityProfile({
      config: { session: { store: storePath } },
      sessionKey,
      agentId: "main",
      modelProvider: "ollama",
      modelId: "qwen3.5:9b",
    });
    expect(profile.policy).toMatchObject({
      explicitToolAllowlist: expect.arrayContaining(["image_generate"]),
      explicitToolOverrideAllowlist: expect.not.arrayContaining(["image_generate"]),
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
      const harnessTools = async () =>
        resolvePluginHarnessPolicyToolsAllow(
          await preparePluginHarnessToolPolicies({
            ...params,
            provider: "fixture",
            modelId: "fixture-model",
            senderId: "sender",
            conversationToolPolicy: { deny: ["*"] },
          }),
        );

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

describe("requester conversation policy admission", () => {
  let registry: ReturnType<typeof captureActivePluginRegistrySnapshot>;
  beforeEach(() => {
    registry = captureActivePluginRegistrySnapshot();
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "telegram" }),
      security: {
        resolveDirectToolPolicy: ({ cfg, accountId, conversationId, senderId }) =>
          accountId === "work" && conversationId === "42" && senderId === "alice"
            ? cfg.channels?.telegram?.direct?.[conversationId]?.tools
            : { allow: ["read"] },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]));
  });
  afterEach(() => restoreActivePluginRegistrySnapshot(registry));

  it("resolves new admission config for the original DM while preserving the source policy", () => {
    const source = resolveProfile(
      direct({
        config: {
          agents: { entries: { source: { tools: { allow: ["read"] } } } },
          channels: { telegram: { direct: { "42": { tools: { deny: ["exec"] } } } } },
        },
        agentId: "source",
        sessionKey: "agent:source:main",
      }),
    );
    const destination = resolveProfile(
      direct({
        config: {
          channels: { telegram: { direct: { "42": { tools: { deny: ["write"] } } } } },
        },
        agentId: "destination",
        sessionKey: "agent:destination:main",
        messageProvider: "webchat",
        agentAccountId: "receiver",
        conversationId: "99",
        senderId: "bob",
        requesterOrigin: source.requesterOrigin,
      }),
    );

    expect(project(source)).toEqual(["read"]);
    expect(project(destination)).toEqual(["read", "exec"]);
    expect(source.policy.groupPolicy).toEqual({ deny: ["exec"] });
    expect(destination.requesterOrigin).toMatchObject({
      accountId: "work",
      conversationId: "42",
      senderId: "alice",
    });
  });

  it("keeps legacy policy on the original queued execution without inheriting it in requester facts", () => {
    const initial = direct({ conversationToolPolicy: { allow: ["read"] } });
    const source = resolveProfile(initial);
    const queued = resolveProfile({
      ...initial,
      requesterOrigin: source.requesterOrigin,
    });
    const delegated = resolveProfile({
      config: { channels: { telegram: { direct: { "42": { tools: {} } } } } },
      sessionKey: "agent:destination:main",
      requesterOrigin: source.requesterOrigin,
    });

    expect(project(queued)).toEqual(["read"]);
    expect(project(delegated)).toEqual(["read", "write", "exec"]);
    expect(source.requesterOrigin).not.toHaveProperty("conversationToolPolicy");
  });

  it("keeps execution-local non-owner authority with preserved owner requester identity", () => {
    const origin = resolveProfile({
      sessionKey: "agent:main:main",
      messageProvider: INTERNAL_MESSAGE_CHANNEL,
      operatorProfileId: "operator-alice",
      senderIsOwner: true,
    }).requesterOrigin;
    const maintenance = resolveProfile({
      requesterOrigin: origin,
      senderIsOwner: false,
      config: { tools: { toolsBySender: { "*": { deny: ["exec"] } } } },
    });
    expect(project(maintenance)).toEqual(["read", "write"]);
    expect(maintenance.sender.isOwner).toBe(false);
    expect(origin).not.toHaveProperty("senderIsOwner");
  });
});
