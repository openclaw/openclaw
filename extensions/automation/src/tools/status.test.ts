import { describe, expect, it } from "vitest";
import { createStatusTool } from "./status.js";

describe("automation status tool", () => {
  it("returns zh-tw fixed success fields", async () => {
    const tool = createStatusTool({} as any);
    const result = await tool.execute("id", {});
    const payload = result.details as Record<string, unknown>;
    expect(payload["回覆狀態"]).toBe("SUCCESS");
    expect(payload["error_code"]).toBe("NONE");
    expect(payload["next_action"]).toBe("NEXT_TASK");
    expect(payload["系統"]).toBe("OpenClaw 自動化中控");
  });

  it("includes verbose config block when verbose=true", async () => {
    const tool = createStatusTool({
      config: { agents: { defaults: { model: "openai/gpt-5.4" } } },
    } as any);
    const result = await tool.execute("id", { verbose: true });
    const payload = result.details as { 設定?: { defaultAgent?: string } };
    expect(payload.設定?.defaultAgent).toBe("openai/gpt-5.4");
  });
});
