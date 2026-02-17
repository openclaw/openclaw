import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[3];

describe("pi tool definition adapter", () => {
  it("wraps tool errors into a tool result", async () => {
    const tool = {
      name: "boom",
      label: "Boom",
      description: "throws",
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool]);
    const args: Parameters<(typeof defs)[number]["execute"]> = [
      "call1",
      {},
      undefined,
      extensionContext,
      undefined,
    ];
    const result = await defs[0].execute(...args);

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
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool]);
    const args: Parameters<(typeof defs)[number]["execute"]> = [
      "call2",
      {},
      undefined,
      extensionContext,
      undefined,
    ];
    const result = await defs[0].execute(...args);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "nope",
    });
  });
});
