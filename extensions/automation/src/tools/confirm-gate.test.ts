import { describe, expect, it } from "vitest";
import { createConfirmGateTool } from "./confirm-gate.js";

describe("automation confirm-gate tool", () => {
  it("returns fixed-format error when operation is missing", async () => {
    const tool = createConfirmGateTool({} as any);
    await expect(tool.execute("id", {})).rejects.toThrow("error_code=CONFIRM_INPUT_INVALID");
  });

  it("returns success fields and interactive buttons", async () => {
    const tool = createConfirmGateTool({} as any);
    const result = await tool.execute("id", {
      operation: "git push origin main",
      riskLevel: "high",
      timeoutMinutes: 15,
    });

    const payload = result.details as {
      回覆狀態?: string;
      error_code?: string;
      next_action?: string;
      status?: string;
      interactive?: { blocks?: Array<{ type?: string; buttons?: Array<{ value?: string }> }> };
    };

    expect(payload.回覆狀態).toBe("SUCCESS");
    expect(payload.error_code).toBe("NONE");
    expect(payload.next_action).toBe("WAIT_USER_CONFIRMATION");
    expect(payload.status).toBe("awaiting_confirmation");
    const buttonBlock = payload.interactive?.blocks?.find((b) => b.type === "buttons");
    expect(buttonBlock?.buttons?.length).toBe(2);
    expect(buttonBlock?.buttons?.[0]?.value).toMatch(/^sc:approve:/);
    expect(buttonBlock?.buttons?.[1]?.value).toMatch(/^sc:deny:/);
  });
});
