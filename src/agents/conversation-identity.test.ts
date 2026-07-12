import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConversationIdentity } from "./conversation-identity.js";

const config = {
  agents: {
    list: [{ id: "personal", default: true }, { id: "referrals" }],
  },
} satisfies OpenClawConfig;

describe("resolveConversationIdentity", () => {
  it("allows the configured owner to use the personal agent in a direct conversation", () => {
    expect(
      resolveConversationIdentity({
        config,
        scope: "direct",
        agentId: "personal",
        senderIsConfiguredOwner: true,
      }),
    ).toEqual({ mode: "personal", reason: "private-owner" });
  });

  it("allows an explicitly bound non-default service agent", () => {
    expect(
      resolveConversationIdentity({
        config,
        scope: "shared",
        agentId: "referrals",
        staticBindingAgentId: "referrals",
        senderIsConfiguredOwner: false,
      }),
    ).toEqual({ mode: "organization", reason: "configured-service-agent" });
  });

  it("does not treat an explicit shared binding to the default agent as organization mode", () => {
    expect(
      resolveConversationIdentity({
        config,
        scope: "shared",
        agentId: "personal",
        staticBindingAgentId: "personal",
        senderIsConfiguredOwner: true,
      }),
    ).toEqual({ mode: "external", reason: "shared-default-agent" });
  });

  it.each([
    {
      name: "an unbound shared audience",
      scope: "shared" as const,
      agentId: "personal",
      senderIsConfiguredOwner: true,
      reason: "shared-default-agent",
    },
    {
      name: "a non-owner personal audience",
      scope: "direct" as const,
      agentId: "personal",
      senderIsConfiguredOwner: false,
      reason: "non-owner-default-agent",
    },
    {
      name: "a mismatched service binding",
      scope: "shared" as const,
      agentId: "personal",
      staticBindingAgentId: "referrals",
      senderIsConfiguredOwner: false,
      reason: "configured-agent-mismatch",
    },
    {
      name: "an unconfigured service agent",
      scope: "shared" as const,
      agentId: "missing",
      staticBindingAgentId: "missing",
      senderIsConfiguredOwner: false,
      reason: "unconfigured-agent",
    },
  ])("denies $name", (testCase) => {
    expect(resolveConversationIdentity({ config, ...testCase })).toEqual({
      mode: "external",
      reason: testCase.reason,
    });
  });
});
