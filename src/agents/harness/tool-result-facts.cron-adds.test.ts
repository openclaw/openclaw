import { describe, expect, it } from "vitest";
import { recordAgentHarnessToolResultTelemetry } from "./tool-result-facts.js";

function telemetry() {
  return {
    toolAutoDeliveryMediaUrls: [] as string[],
    coreTtsToolResults: [] as object[],
    confirmedMediaDeliveries: [] as Array<{ kind: string }>,
  };
}

function recordCronAdd(
  toolName: string,
  args: Record<string, unknown> = { action: "add" },
  isError = false,
) {
  const facts = telemetry();
  recordAgentHarnessToolResultTelemetry({
    toolName,
    args,
    result: undefined,
    telemetry: facts,
    isError,
    messagingDelivered: false,
    mediaDeliveryConfirmed: false,
    extractSourceReplyPayload: () => undefined,
    collectMessagingMediaUrls: () => [],
    resolveMessagingMediaSourceUrls: () => [],
    signal: new AbortController().signal,
  });
  return facts.successfulCronAdds ?? 0;
}

describe("successfulCronAdds", () => {
  it("counts both the canonical tool name and the cron alias", () => {
    expect(recordCronAdd("automations")).toBe(1);
    expect(recordCronAdd("cron")).toBe(1);
  });

  it("counts the tool through the loopback MCP transport prefixes", () => {
    expect(recordCronAdd("mcp__openclaw__automations")).toBe(1);
    expect(recordCronAdd("mcp_openclaw_cron")).toBe(1);
  });

  it("ignores non-add actions, other tools and failed calls", () => {
    expect(recordCronAdd("automations", { action: "list" })).toBe(0);
    expect(recordCronAdd("calendar", { action: "add" })).toBe(0);
    expect(recordCronAdd("automations", { action: "add" }, true)).toBe(0);
  });
});
