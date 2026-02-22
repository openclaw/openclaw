import { describe, expect, it } from "vitest";
import { createExecTool } from "./bash-tools.exec.js";

describe("exec tool schema defaults", () => {
  it("reflects configured tools.exec.host as host default", () => {
    const tool = createExecTool({ host: "gateway" });
    const schema = tool.parameters as {
      properties?: Record<string, { default?: unknown }>;
    };

    expect(schema.properties?.host?.default).toBe("gateway");
  });

  it("defaults host to sandbox when not configured", () => {
    const tool = createExecTool(undefined);
    const schema = tool.parameters as {
      properties?: Record<string, { default?: unknown }>;
    };

    expect(schema.properties?.host?.default).toBe("sandbox");
  });
});
