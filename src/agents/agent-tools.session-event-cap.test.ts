import { expect, it, vi } from "vitest";
import { createOpenClawCodingToolsInternal } from "./agent-tools.js";
import * as pluginTools from "./openclaw-plugin-tools.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

async function observeCallerIdentity(senderId: string, toolPolicyScope: "conversation" | "turn") {
  let identity: ReturnType<typeof getGatewayToolCallerIdentity>;
  const spy = vi.spyOn(pluginTools, "resolveOpenClawPluginToolsForOptions").mockReturnValue([
    {
      ...createStubTool("file_fetch"),
      execute: async () => {
        identity = getGatewayToolCallerIdentity();
        return { content: [], details: {} };
      },
    },
  ]);
  try {
    const tools = createOpenClawCodingToolsInternal({
      agentId: "main",
      config: { tools: { toolsBySender: { "id:guest": { deny: ["exec", "process"] } } } },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
      messageProvider: "discord",
      senderId,
      toolPolicyScope,
      includeCoreTools: false,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: true,
      },
    });
    await tools.find((tool) => tool.name === "file_fetch")?.execute?.("tool-call", {});
    return identity;
  } finally {
    spy.mockRestore();
  }
}

it.for([
  { sender: "an unrestricted sender", senderId: "owner", scope: "conversation", scoped: true },
  {
    sender: "a sender narrowed by toolsBySender",
    senderId: "guest",
    scope: "conversation",
    scoped: undefined,
  },
  { sender: "a turn-scoped policy", senderId: "owner", scope: "turn", scoped: undefined },
] as const)(
  "marks the follow-up cap session-scoped only for $sender",
  async ({ senderId, scope, scoped }) => {
    const identity = await observeCallerIdentity(senderId, scope);
    expect(identity?.sessionEventToolsAllow).toEqual(expect.arrayContaining(["file_fetch"]));
    expect(identity?.sessionEventToolsAllowSessionScoped).toBe(scoped);
  },
);
