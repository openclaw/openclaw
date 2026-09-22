import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createMeetingPluginFixture,
  defineMeetingPluginSurfaceTests,
} from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { ZOOM_MEETINGS_CLI_METADATA } from "./src/cli-output-mode.js";

const MEETING_URL = "https://zoom.us/j/12345678901?pwd=owned";

const fixture = createMeetingPluginFixture({
  plugin,
  id: "zoom-meetings",
  name: "Zoom meetings",
  url: MEETING_URL,
  title: "Zoom",
  tabId: "zoom-tab",
  methodPrefix: "zoommeetings",
  toolName: "zoom_meetings",
  nodeCommand: "zoommeetings.chrome",
  descriptor: ZOOM_MEETINGS_CLI_METADATA.descriptor,
  transcriptSource: { id: "zoom", aliases: ["zoom-meetings"] },
});

describe("Zoom meetings plugin surface", () => {
  defineMeetingPluginSurfaceTests(fixture);

  it("does not expose the dangerous node surface when disabled", () => {
    const nodeCommands: unknown[] = [];
    const policies: unknown[] = [];
    const api = fixture.createApi({
      pluginConfig: { enabled: false },
      registerNodeHostCommand: (command: unknown) => nodeCommands.push(command),
      registerNodeInvokePolicy: (policy: unknown) => policies.push(policy),
    });

    plugin.register(api);

    expect(nodeCommands).toEqual([]);
    expect(policies).toEqual([]);
  });

  it("routes main-agent tool calls through the ownership-attested runtime", async () => {
    const gatewayRequest = vi.fn(async () => ({ found: true, sessions: [] }));
    let tool:
      | { execute: (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }> }
      | undefined;
    const api = fixture.createApi({
      pluginConfig: {},
      runtime: {
        gateway: { isAvailable: vi.fn(async () => true), request: gatewayRequest },
      } as unknown as OpenClawPluginApi["runtime"],
      registerTool: (registered: unknown) => {
        tool = (
          typeof registered === "function"
            ? (registered as (context: Record<string, unknown>) => typeof tool)({
                agentId: "main",
                sessionKey: "agent:main:main",
              })
            : registered
        ) as typeof tool;
      },
    });
    plugin.register(api);

    await tool?.execute("id", { action: "status" });

    expect(gatewayRequest).toHaveBeenCalledWith(
      "zoommeetings.status",
      {
        action: "status",
        agentId: "main",
        requesterSessionKey: "agent:main:main",
      },
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });
});
