// Scheduled show_widget registration and allowlist coverage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { createOpenClawCodingToolsAsync } from "./agent-tools.js";
import { resolveEmbeddedAttemptToolConstructionPlan } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { createOpenClawToolsAsync } from "./openclaw-tools.js";

// mock-isolation: Scheduled widget assembly excludes installed plugin activation.
vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptionsAsync: async () => [],
}));
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

function expectWidget(tools: Awaited<ReturnType<typeof createOpenClawToolsAsync>>) {
  const tool = tools.find((candidate) => candidate.name === "show_widget");
  if (!tool) {
    throw new Error("Expected show_widget to be registered");
  }
  return tool;
}

function expectPinnedOnlySchema(tool: ReturnType<typeof expectWidget>): void {
  const schema = tool.parameters as {
    properties?: { pin?: { const?: boolean } };
    required?: string[];
  };
  expect(tool.requiredClientCaps).toBeUndefined();
  expect(schema.required).toContain("pin");
  expect(schema.properties?.pin?.const).toBe(true);
}

describe("pinned show_widget registration", () => {
  it.each([undefined, "agent:main:cron:job:run:detached"])(
    "requires a persistent session for recovered authoring (%s)",
    async (agentSessionKey) => {
      const tools = await createOpenClawToolsAsync({
        agentSessionKey,
        pinnedWidgetAuthoring: true,
      });
      expect(tools.some((tool) => tool.name === "show_widget")).toBe(false);
    },
  );

  it("applies tool policy to recovered dashboard authoring", async () => {
    const options = {
      sessionKey: "agent:main:dashboard:recovered",
      pinnedWidgetAuthoring: true,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    };
    expectPinnedOnlySchema(expectWidget(await createOpenClawCodingToolsAsync(options)));
    const deniedTools = await createOpenClawCodingToolsAsync({
      ...options,
      config: { tools: { deny: ["show_widget"] } },
    });
    expect(deniedTools.some((tool) => tool.name === "show_widget")).toBe(false);
  });

  it("does not let scheduled provenance replace an explicit widget cap", async () => {
    const tools = await createOpenClawToolsAsync({
      agentSessionKey: "agent:main:dashboard:scheduled",
      gatewayCallerScheduled: true,
    });

    expect(tools.some((tool) => tool.name === "show_widget")).toBe(false);
  });

  it("honors an explicit widget deny on the scheduled surface", async () => {
    const tools = await createOpenClawToolsAsync({
      agentSessionKey: "agent:main:dashboard:scheduled",
      gatewayCallerScheduled: true,
      runtimeToolAllowlist: ["show_widget"],
      config: { tools: { deny: ["show_widget"] } },
    });

    expect(tools.some((tool) => tool.name === "show_widget")).toBe(false);
  });

  it.each(["canvas"])(
    "lets a server-authorized %s cap select pinned widget authoring",
    async (toolName) => {
      const toolsAllow = [toolName];
      const plan = resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow });
      const tools = await createOpenClawCodingToolsAsync({
        sessionKey: "agent:main:dashboard:scheduled",
        scheduledToolPolicy: { version: 1, mode: "trusted" },
        runtimeToolAllowlist: plan.runtimeToolAllowlist,
        includeCoreTools: plan.includeCoreTools,
        config: { tools: { allow: toolsAllow } },
        toolConstructionPlan: plan.codingToolConstructionPlan,
      });

      expectPinnedOnlySchema(expectWidget(tools));
    },
  );

  it("keeps scheduled turns with a real inline client on the normal widget surface", async () => {
    const tool = expectWidget(
      await createOpenClawToolsAsync({
        agentSessionKey: "agent:main:dashboard:scheduled",
        gatewayCallerScheduled: true,
        runtimeToolAllowlist: ["show_widget"],
        clientCaps: ["inline-widgets"],
      }),
    );
    const schema = tool.parameters as { required?: string[] };

    expect(tool.requiredClientCaps).toEqual(["inline-widgets"]);
    expect(schema.required).not.toContain("pin");
  });
});
