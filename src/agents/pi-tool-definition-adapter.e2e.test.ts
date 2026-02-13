import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

describe("pi tool definition adapter", () => {
  it("wraps tool errors into a tool result", async () => {
    const tool = {
      name: "boom",
      label: "Boom",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call1", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "boom",
    });
    expect(result.details).toMatchObject({ error: "nope" });
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call2", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "nope",
    });
  });

  it("includes truncated stderr when provided by the tool error", async () => {
    const longStderr =
      Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n") + "\ntrailing";
    const tool = {
      name: "exec",
      label: "Exec",
      description: "fails with stderr",
      parameters: {},
      execute: async () => {
        const err = new Error("Command exited with code 1") as Error & { stderr?: string };
        err.stderr = longStderr;
        throw err;
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call3", {}, undefined, undefined);

    const details = result.details as {
      status: string;
      tool: string;
      error: string;
      stderr?: string;
    };
    expect(details.status).toBe("error");
    expect(details.tool).toBe("exec");
    expect(details.error).toBe("Command exited with code 1");
    expect(details.stderr).toBeDefined();
    // Should contain the last line and not all 100 original lines.
    expect(details.stderr).toContain("trailing");
    expect(details.stderr?.split("\n").length).toBeLessThanOrEqual(50);
  });
});
