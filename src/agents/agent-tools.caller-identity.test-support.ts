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
        requesterOrigin: expect.objectContaining({
          sessionKey: "agent:main:telegram:direct:alice",
          messageProvider: "discord-voice",
          accountId: "work",
          messageThreadId: "42",
        }),
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

  it("carries this turn's provider-hosted web_search decision into session events", async () => {
    let observedAllow: readonly string[] | undefined;
    const resolvePluginToolsSpy = vi
      .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptions")
      .mockReturnValue([
        {
          name: "file_fetch",
          label: "File fetch",
          description: "Fetch a file",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            observedAllow = getGatewayToolCallerIdentity()?.sessionEventToolsAllow;
            return { content: [{ type: "text" as const, text: "ok" }], details: {} };
          },
        },
      ]);
    try {
      const tools = createOpenClawCodingTools({
        config: testConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
        includeCoreTools: false,
        toolConstructionPlan: pluginOnlyConstructionPlan,
      });
      await requireTool(tools, "file_fetch").execute?.("tool-call-1", {});
      expect(observedAllow).toEqual(["file_fetch", "web_search"]);
      // A producer whose policy denies web_search passes no hosted search to its events.
      const denied = createOpenClawCodingTools({
        config: { ...testConfig, tools: { ...testConfig.tools, deny: ["web_search"] } },
        agentId: "main",
        sessionKey: "agent:main:main",
        includeCoreTools: false,
        toolConstructionPlan: pluginOnlyConstructionPlan,
      });
      await requireTool(denied, "file_fetch").execute?.("tool-call-2", {});
      expect(observedAllow).toEqual(["file_fetch"]);
    } finally {
      resolvePluginToolsSpy.mockRestore();
    }
  });
}
