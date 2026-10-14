import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import * as openClawPluginTools from "./openclaw-plugin-tools.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

type CodingTools = ReturnType<typeof createOpenClawCodingTools>;

export function registerPluginOnlyCallerIdentityCase({
  testConfig,
  requireTool,
}: {
  testConfig: OpenClawConfig;
  requireTool: (tools: CodingTools, name: string) => CodingTools[number];
}) {
  const pluginOnlyConstructionPlan = {
    includeBaseCodingTools: false,
    includeShellTools: false,
    includeChannelTools: false,
    includeOpenClawTools: false,
    includePluginTools: true,
  };

  it("wraps plugin-only tools with scheduled creator authority and live routing context", async () => {
    let observedIdentity: ReturnType<typeof getGatewayToolCallerIdentity>;
    const resolvePluginToolsSpy = vi
      .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptions")
      .mockReturnValue([
        {
          name: "file_fetch",
          label: "File fetch",
          description: "Fetch a file",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            observedIdentity = getGatewayToolCallerIdentity();
            return { content: [{ type: "text" as const, text: "ok" }], details: {} };
          },
        },
      ]);

    try {
      const tools = createOpenClawCodingTools({
        config: {
          ...testConfig,
          channels: {
            discord: {
              accounts: {
                creator: {},
              },
            },
          },
        },
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:alice",
        messageProvider: "discord-voice",
        messageChannel: "discord",
        messageTo: "channel:123",
        agentAccountId: "work",
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "creator",
          ownerOrigin: { kind: "external", channel: "discord" },
        },
        messageThreadId: "42",
        includeCoreTools: false,
        runtimeToolAllowlist: ["file_fetch"],
        inheritRuntimeToolAllowlist: true,
        toolConstructionPlan: pluginOnlyConstructionPlan,
      });

      await requireTool(tools, "file_fetch").execute?.("tool-call-1", {});
      expect(observedIdentity).toEqual({
        agentId: "main",
        assertToolAllowed: expect.any(Function),
        personalToolIdentityScoped: undefined,
        personalToolParticipants: undefined,
        personalToolSelection: undefined,
        personalToolUser: undefined,
        sessionEventDelivery: undefined,
        sessionEventSettings: { permissionMode: undefined },
        sessionEventToolsAllow: ["file_fetch"],
        sessionKey: "agent:main:telegram:direct:alice",
        turnSourceChannel: "discord",
        turnSourceTo: "channel:123",
        turnSourceAccountId: "creator",
        turnSourceThreadId: "42",
      });
      expect(() => observedIdentity?.assertToolAllowed?.("file_fetch")).not.toThrow();
      expect(() => observedIdentity?.assertToolAllowed?.("exec")).toThrow(
        "exec is not allowed by this conversation's tool policy",
      );
    } finally {
      resolvePluginToolsSpy.mockRestore();
    }
  });
}
