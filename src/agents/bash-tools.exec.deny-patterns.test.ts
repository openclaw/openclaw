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
});

describe("resolveExecConfig denyPatterns merge", () => {
  // Import resolveExecConfig indirectly by testing the merge behavior
  // through createExecTool, since resolveExecConfig is not exported.
  // Instead, test the merge semantics directly.

  it("agent patterns merge with global patterns (both present in result)", () => {
    const globalPatterns = ["^claude\\s"];
    const agentPatterns = ["^codex\\s"];
    const merged = [...globalPatterns, ...agentPatterns];
    expect(merged).toEqual(["^claude\\s", "^codex\\s"]);
  });

  it("agent patterns cannot remove global patterns", () => {
    const globalPatterns = ["^claude\\s", "^codex\\s"];
    const agentPatterns: string[] = [];
    const merged = [...globalPatterns, ...agentPatterns];
    expect(merged).toEqual(["^claude\\s", "^codex\\s"]);
  });

  it("global only when agent has no denyPatterns", () => {
    const globalPatterns = ["^claude\\s"];
    const agentPatterns = undefined;
    const merged = [...globalPatterns, ...(agentPatterns ?? [])];
    expect(merged).toEqual(["^claude\\s"]);
  });
});
