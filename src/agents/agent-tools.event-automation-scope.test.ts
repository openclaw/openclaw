import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import { createOpenClawCodingToolsInternal } from "./agent-tools.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";
import * as gateway from "./tools/gateway.js";

beforeEach(() => {
  setRuntimeConfigSnapshot({ tools: { allow: [AUTOMATIONS_TOOL_NAME] } });
  vi.spyOn(gateway, "callGatewayTool").mockResolvedValue({ ok: true });
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

it.each(["cron", "event"] as const)(
  "%s turns reject sibling automation removal before Gateway dispatch",
  async (trigger) => {
    const tools = createOpenClawCodingToolsInternal({
      trigger,
      jobId: "current-hook-job",
      senderIsOwner: true,
      config: { tools: { allow: [AUTOMATIONS_TOOL_NAME] } },
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });
    const automations = tools.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME);
    if (!automations) {
      throw new Error("Expected the current-job automations tool");
    }
    await expect(
      automations.execute("remove-sibling", { action: "remove", jobId: "sibling-job" }),
    ).rejects.toThrow("Automations tool is restricted to the current automation.");
    expect(gateway.callGatewayTool).not.toHaveBeenCalled();
  },
);
