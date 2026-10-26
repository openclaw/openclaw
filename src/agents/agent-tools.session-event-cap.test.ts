import { expect, it, vi } from "vitest";
import type { SessionEventSourcePolicy } from "../auto-reply/reply/session-event-contract.js";

const policies: Array<SessionEventSourcePolicy | undefined> = [];
vi.mock("./agent-tools.caller.js", () => ({
  createCodingToolsGatewayCaller: (params: {
    sessionEventSourcePolicy?: SessionEventSourcePolicy;
  }) => {
    policies.push(params.sessionEventSourcePolicy);
    return <T>(tool: T) => tool;
  },
}));

const { createOpenClawCodingTools } = await import("./agent-tools.js");

it.for([
  { sender: "an unrestricted sender", senderId: "owner", scoped: true },
  { sender: "a sender narrowed by toolsBySender", senderId: "guest", scoped: undefined },
])("marks the follow-up cap session-scoped only for $sender", ({ senderId, scoped }) => {
  policies.length = 0;
  createOpenClawCodingTools({
    config: { tools: { toolsBySender: { "id:guest": { deny: ["exec", "process"] } } } },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp/test",
    agentDir: "/tmp/agent",
    messageProvider: "discord",
    senderId,
    toolPolicyScope: "conversation",
  });
  expect(policies).toHaveLength(1);
  expect(policies[0]?.toolsAllow).toEqual(expect.arrayContaining(["read"]));
  expect(policies[0]?.toolsAllowSessionScoped).toBe(scoped);
});
