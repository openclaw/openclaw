import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import * as pluginTools from "./openclaw-plugin-tools.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

type CodingTools = ReturnType<typeof createOpenClawCodingTools>;

export function registerPluginOnlyCallerIdentityCase({
  testConfig,
  requireTool,
}: {
  testConfig: OpenClawConfig;
  requireTool: (tools: CodingTools, name: string) => CodingTools[number];
}) {
  async function execute(options: NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>) {
    let identity: ReturnType<typeof getGatewayToolCallerIdentity>;
    using spy = vi.spyOn(pluginTools, "resolveOpenClawPluginToolsForOptions");
    spy.mockReturnValue([
      {
        ...createStubTool("file_fetch"),
        execute: async () => {
          identity = getGatewayToolCallerIdentity();
          return { content: [], details: {} };
        },
      },
    ]);
    const tools = createOpenClawCodingTools({
      agentId: "main",
      includeCoreTools: false,
      ...options,
    });
    await requireTool(tools, "file_fetch").execute?.("tool-call", {});
    return identity;
  }
  it("wraps plugin-only tools with scheduled creator authority and live routing context", async () => {
    const observedIdentity = await execute({
      config: {
        ...testConfig,
        channels: { discord: { accounts: { creator: {} } } },
      },
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
      runtimeToolAllowlist: ["file_fetch"],
      inheritRuntimeToolAllowlist: true,
    });
    expect(observedIdentity).toMatchObject({
      agentId: "main",
      requesterOrigin: expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:alice",
        messageProvider: "discord-voice",
        accountId: "work",
        messageThreadId: "42",
      }),
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
  });

  it("carries this turn's provider-hosted web_search decision into session events", async () => {
    const options = { config: testConfig, sessionKey: "agent:main:main" };
    expect((await execute(options))?.sessionEventToolsAllow).toEqual(["file_fetch", "web_search"]);
    const denied = await execute({
      ...options,
      config: { ...testConfig, tools: { ...testConfig.tools, deny: ["web_search"] } },
    });
    expect(denied?.sessionEventToolsAllow).toEqual(["file_fetch"]);
  });
}
