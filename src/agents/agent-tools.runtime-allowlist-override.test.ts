import { describe, expect, it } from "vitest";
import { createOpenClawCodingTools } from "./agent-tools.js";

describe("createOpenClawCodingTools runtimeToolAllowlist override", () => {
  it("includes exec when cron wildcard allowlist overrides messaging profile", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
      runtimeToolAllowlist: ["*"],
      trigger: "cron",
    });
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("exec");
    expect(toolNames).toContain("process");
  });

  it("excludes exec with messaging profile and no runtime wildcard", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
    });
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("process");
  });

  it("does not override messaging profile for non-cron callers even with wildcard", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
      runtimeToolAllowlist: ["*"],
      trigger: "interactive",
    });
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("process");
  });

  it("process tool presence implies allowBackground is true under cron wildcard", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
      runtimeToolAllowlist: ["*"],
      trigger: "cron",
    });
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("process");
  });

  it("does not allow exec with messaging profile and no runtime wildcard even with trigger cron", () => {
    const tools = createOpenClawCodingTools({
      config: {
        tools: { profile: "messaging" },
      } as unknown as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>["config"],
      trigger: "cron",
    });
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain("exec");
  });
});
