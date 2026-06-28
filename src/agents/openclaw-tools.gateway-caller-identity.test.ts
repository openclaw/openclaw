// Verifies plugin tools inherit the agent Gateway caller identity from tool assembly.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  observedIdentities: [] as Array<unknown>,
}));

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [
    {
      name: "synthetic_direct_cron_plugin",
      label: "Synthetic direct cron plugin",
      description: "Calls Gateway cron directly like plugin-owned reminder tools.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const { getGatewayToolCallerIdentity } = await import("./tools/gateway-caller-context.js");
        mocks.observedIdentities.push(getGatewayToolCallerIdentity());
        return { content: [{ type: "text", text: "ok" }] };
      },
    },
  ],
}));

import { createOpenClawTools } from "./openclaw-tools.js";

function requireTool(name: string) {
  const tool = createOpenClawTools({
    agentSessionKey: "agent:main:discord:channel:123",
    disableMessageTool: true,
    pluginToolAllowlist: [name],
    requesterAgentIdOverride: "main",
    wrapBeforeToolCallHook: false,
  }).find((candidate) => candidate.name === name);
  if (!tool?.execute) {
    throw new Error(`Expected executable tool ${name}`);
  }
  return tool;
}

describe("createOpenClawTools Gateway caller identity", () => {
  it("wraps plugin tools so direct cron Gateway calls inherit the agent identity", async () => {
    mocks.observedIdentities.length = 0;

    const tool = requireTool("synthetic_direct_cron_plugin");
    await tool.execute("tool-call-1", {});

    expect(mocks.observedIdentities).toEqual([
      {
        agentId: "main",
        sessionKey: "agent:main:discord:channel:123",
      },
    ]);
  });
});
