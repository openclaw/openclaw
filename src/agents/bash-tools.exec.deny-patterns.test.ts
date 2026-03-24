import { afterEach, describe, expect, it } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";

afterEach(() => {
  resetProcessRegistryForTests();
});

const BASE_DEFAULTS = { security: "full" as const, ask: "off" as const };

describe("exec denyPatterns", () => {
  it("blocks execution when command matches a deny pattern", async () => {
    const tool = createExecTool({
      ...BASE_DEFAULTS,
      denyPatterns: ["^claude\\s"],
    });
    await expect(tool.execute("t1", { command: "claude --print hello" })).rejects.toThrow(
      /exec denied.*deny pattern.*\^claude\\s/,
    );
  });

  it("allows execution when command does not match any deny pattern", async () => {
    const tool = createExecTool({
      ...BASE_DEFAULTS,
      allowBackground: false,
      denyPatterns: ["^claude\\s"],
    });
    const result = await tool.execute("t2", { command: "echo ok" });
    expect(result.details.status).toBe("completed");
  });

  it("skips invalid regex patterns gracefully", async () => {
    const tool = createExecTool({
      ...BASE_DEFAULTS,
      allowBackground: false,
      denyPatterns: ["[invalid("],
    });
    const result = await tool.execute("t3", { command: "echo ok" });
    expect(result.details.status).toBe("completed");
  });

  it("treats empty denyPatterns array as a no-op", async () => {
    const tool = createExecTool({
      ...BASE_DEFAULTS,
      allowBackground: false,
      denyPatterns: [],
    });
    const result = await tool.execute("t4", { command: "echo ok" });
    expect(result.details.status).toBe("completed");
  });

  it("first matching pattern name appears in the error message", async () => {
    const tool = createExecTool({
      ...BASE_DEFAULTS,
      denyPatterns: ["^codex\\s", "^claude\\s"],
    });
    await expect(tool.execute("t5", { command: "claude --print hi" })).rejects.toThrow(
      /deny pattern.*\^claude\\s/,
    );
  });

  it("matches against the full command string including arguments", async () => {
    const tool = createExecTool({
      ...BASE_DEFAULTS,
      denyPatterns: ["claude --permission-mode"],
    });
    await expect(
      tool.execute("t6", {
        command: "claude --permission-mode bypassPermissions --print foo",
      }),
    ).rejects.toThrow(/exec denied/);
  });

  it("blocks commands with leading whitespace via trim", async () => {
    const tool = createExecTool({
      ...BASE_DEFAULTS,
      denyPatterns: ["^claude\\s"],
    });
    await expect(tool.execute("t7", { command: "  claude --print hi" })).rejects.toThrow(
      /exec denied/,
    );
  });
});

describe("denyPatterns merge semantics via createExecTool", () => {
  it("merged patterns from both sources block their respective commands", async () => {
    // Simulates the output of resolveExecConfig additive merge:
    // global ["^claude\\s"] + agent ["^codex\\s"] = both enforced
    const tool = createExecTool({
      ...BASE_DEFAULTS,
      denyPatterns: ["^claude\\s", "^codex\\s"],
    });
    await expect(tool.execute("m1", { command: "claude --print hi" })).rejects.toThrow(
      /exec denied/,
    );
    await expect(tool.execute("m2", { command: "codex --print hi" })).rejects.toThrow(
      /exec denied/,
    );
  });

  it("empty agent patterns do not remove global patterns", async () => {
    // global ["^claude\\s"] + agent [] = global still enforced
    const tool = createExecTool({
      ...BASE_DEFAULTS,
      denyPatterns: ["^claude\\s"],
    });
    await expect(tool.execute("m3", { command: "claude --print hi" })).rejects.toThrow(
      /exec denied/,
    );
  });

  it("unrelated commands pass through merged patterns", async () => {
    const tool = createExecTool({
      ...BASE_DEFAULTS,
      allowBackground: false,
      denyPatterns: ["^claude\\s", "^codex\\s"],
    });
    const result = await tool.execute("m4", { command: "echo ok" });
    expect(result.details.status).toBe("completed");
  });
});
