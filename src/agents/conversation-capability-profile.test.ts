import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";

describe("resolveConversationCapabilityProfile", () => {
  it("prepares a direct conversation profile with sender tool restrictions", () => {
    const cfg: OpenClawConfig = {
      tools: {
        toolsBySender: {
          "id:guest": { deny: ["exec", "process"] },
        },
      },
    };

    const profile = resolveConversationCapabilityProfile({
      config: cfg,
      sessionKey: "agent:main:discord:dm:guest",
      agentId: "main",
      messageProvider: "discord",
      chatType: "direct",
      senderId: "guest",
      modelProvider: "openai",
      modelId: "gpt-5.5",
      modelApi: "responses",
      workspaceDir: "/tmp/openclaw-direct-profile",
      cwd: "/tmp/openclaw-direct-profile/task",
      agentDir: "/tmp/openclaw-agent-direct-profile",
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "ops" }],
      },
    });

    expect(profile.conversation.scope).toBe("direct");
    expect(profile.policy.senderPolicy).toEqual({ deny: ["exec", "process"] });
    expect(profile.policy.explicitToolDenylist).toEqual(["exec", "process"]);
    expect(profile.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.5",
      api: "responses",
    });
    expect(profile.workspace).toMatchObject({
      workspaceRoot: "/tmp/openclaw-direct-profile",
      runtimeRoot: "/tmp/openclaw-direct-profile/task",
      instructionRoot: "/tmp/openclaw-agent-direct-profile",
    });
    expect(profile.skills.snapshot?.skills).toEqual([{ name: "ops" }]);
  });

  it("prepares a shared conversation profile with group per-sender restrictions", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          groups: {
            team: {
              tools: { allow: ["read"] },
              toolsBySender: {
                "id:alice": { allow: ["read", "exec"] },
              },
            },
          },
        },
      },
    };

    const profile = resolveConversationCapabilityProfile({
      config: cfg,
      sessionKey: "agent:main:whatsapp:group:team",
      agentId: "main",
      messageProvider: "whatsapp",
      chatType: "group",
      groupId: "team",
      senderId: "alice",
      modelProvider: "openai",
      modelId: "gpt-5.5",
      workspaceDir: "/tmp/openclaw-shared-profile",
    });

    expect(profile.conversation.scope).toBe("shared");
    expect(profile.policy.trustedGroup).toEqual({ groupId: "team", dropped: false });
    expect(profile.policy.groupPolicy).toEqual({ allow: ["read", "exec"] });
    expect(profile.policy.explicitToolAllowlist).toEqual(["read", "exec"]);
  });
});
