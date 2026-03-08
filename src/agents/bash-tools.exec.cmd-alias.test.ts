import { describe, expect, it } from "vitest";
import { createExecTool } from "./bash-tools.exec.js";

describe("exec tool cmd alias", () => {
  it("treats cmd as an alias for command", async () => {
    const tool = createExecTool();
    try {
      await tool.execute("call_1", { cmd: "echo hi", elevated: true });
      throw new Error("expected exec to fail");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/elevated is not available/i);
      expect(message).not.toMatch(/Provide a command to start/i);
    }
  });
});
