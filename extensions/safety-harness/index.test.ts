import { describe, it, expect, vi } from "vitest";
import { safetyHarnessPlugin } from "./index.js";

describe("safety-harness plugin", () => {
  it("exports a valid OpenClawPluginDefinition", () => {
    expect(safetyHarnessPlugin).toBeDefined();
    expect(safetyHarnessPlugin.id).toBe("safety-harness");
    expect(safetyHarnessPlugin.name).toBe("Safety Harness");
    expect(typeof safetyHarnessPlugin.register).toBe("function");
  });

  it("registers before_tool_call, after_tool_call, and message_sending hooks", async () => {
    const onSpy = vi.fn();
    const mockApi = {
      id: "safety-harness",
      name: "Safety Harness",
      source: "test",
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      on: onSpy,
    } as any;

    await safetyHarnessPlugin.register!(mockApi);

    const hookNames = onSpy.mock.calls.map((c: any[]) => c[0]);
    expect(hookNames).toContain("before_tool_call");
    expect(hookNames).toContain("after_tool_call");
    expect(hookNames).toContain("message_sending");
  });
});
