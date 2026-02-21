import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { toClientToolDefinitions, toToolDefinitions } from "./pi-tool-definition-adapter.js";

type TimedAgentToolResult = AgentToolResult<unknown> & {
  durationMs?: number;
  metadata?: {
    durationMs?: number;
  };
};

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];
const emptySchema = Type.Object({});

async function executeThrowingTool(name: string, callId: string) {
  const tool = {
    name,
    label: name === "bash" ? "Bash" : "Boom",
    description: "throws",
    parameters: emptySchema,
    execute: async () => {
      throw new Error("nope");
    },
  } satisfies AgentTool;

  const defs = toToolDefinitions([tool]);
  const def = defs[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  return await def.execute(callId, {}, undefined, undefined, extensionContext);
}

describe("pi tool definition adapter", () => {
  it("wraps tool errors into a tool result", async () => {
    const result = await executeThrowingTool("boom", "call1");

    expect(result.details).toMatchObject({
      status: "error",
      tool: "boom",
    });
    expect(result.details).toMatchObject({ error: "nope" });
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const result = await executeThrowingTool("bash", "call2");

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "nope",
    });
  });

  it("records durationMs at both root and metadata for successful execution", async () => {
    const tool = {
      name: "ok",
      label: "Ok",
      description: "works",
      parameters: emptySchema,
      execute: async () =>
        ({
          content: [{ type: "text", text: "done" }],
          details: { ok: true },
        }) as AgentToolResult<unknown>,
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool]);
    const result = (await defs[0].execute(
      "call3",
      {},
      undefined,
      undefined,
      extensionContext,
    )) as TimedAgentToolResult;

    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata).toBeDefined();
    expect(typeof result.metadata?.durationMs).toBe("number");
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata?.durationMs).toBe(result.durationMs);
  });

  it("records duration fields consistently for failed execution", async () => {
    const tool = {
      name: "fail",
      label: "Fail",
      description: "fails",
      parameters: emptySchema,
      execute: async () => {
        throw new Error("unlucky");
      },
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool]);
    const result = (await defs[0].execute(
      "call4",
      {},
      undefined,
      undefined,
      extensionContext,
    )) as TimedAgentToolResult;

    expect(result.details).toMatchObject({
      status: "error",
      durationMs: expect.any(Number),
      metadata: {
        durationMs: expect.any(Number),
      },
    });
    expect(typeof result.durationMs).toBe("number");
    expect(typeof result.metadata?.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata?.durationMs).toBe(result.durationMs);
    expect((result.details as { durationMs?: number }).durationMs).toBe(result.durationMs);
    expect((result.details as { metadata?: { durationMs?: number } }).metadata?.durationMs).toBe(
      result.durationMs,
    );
  });

  it("can disable duration metadata injection for successful execution", async () => {
    const tool = {
      name: "okNoDuration",
      label: "OkNoDuration",
      description: "works",
      parameters: emptySchema,
      execute: async () =>
        ({
          content: [{ type: "text", text: "done" }],
          details: { ok: true },
        }) as AgentToolResult<unknown>,
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool], { recordDurationMetadata: false });
    const result = (await defs[0].execute(
      "call-no-duration",
      {},
      undefined,
      undefined,
      extensionContext,
    )) as TimedAgentToolResult;

    expect(result.durationMs).toBeUndefined();
    expect(result.metadata?.durationMs).toBeUndefined();
  });

  it("can disable duration metadata injection for failed execution", async () => {
    const tool = {
      name: "failNoDuration",
      label: "FailNoDuration",
      description: "fails",
      parameters: emptySchema,
      execute: async () => {
        throw new Error("unlucky");
      },
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool], { recordDurationMetadata: false });
    const result = (await defs[0].execute(
      "call-no-duration-fail",
      {},
      undefined,
      undefined,
      extensionContext,
    )) as TimedAgentToolResult;

    expect(result.durationMs).toBeUndefined();
    expect(result.metadata?.durationMs).toBeUndefined();
    expect((result.details as { durationMs?: number }).durationMs).toBeUndefined();
    expect((result.details as { metadata?: { durationMs?: number } }).metadata?.durationMs).toBe(
      undefined,
    );
  });

  it("mirrors existing root durationMs into metadata", async () => {
    const tool = {
      name: "preTimed",
      label: "PreTimed",
      description: "already timed",
      parameters: emptySchema,
      execute: async () => {
        return {
          content: [{ type: "text", text: "done" }],
          details: { ok: true },
          durationMs: 123,
        } as unknown as AgentToolResult<unknown>;
      },
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool]);
    const result = (await defs[0].execute(
      "call5",
      {},
      undefined,
      undefined,
      extensionContext,
    )) as TimedAgentToolResult;

    expect(result.durationMs).toBe(123);
    expect(result.metadata?.durationMs).toBe(123);
  });

  it("records client tool pending duration metadata by default", async () => {
    const [tool] = toClientToolDefinitions([
      {
        type: "function",
        function: {
          name: "client_pending",
          parameters: { type: "object" },
        },
      },
    ]);

    const result = (await tool.execute(
      "client-call-1",
      {},
      undefined,
      undefined,
      extensionContext,
    )) as TimedAgentToolResult;

    const details = result.details as { metadata?: { durationMs?: number } } | undefined;
    expect(typeof details?.metadata?.durationMs).toBe("number");
    expect(details?.metadata?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("can disable client tool pending duration metadata", async () => {
    const [tool] = toClientToolDefinitions(
      [
        {
          type: "function",
          function: {
            name: "client_pending_no_duration",
            parameters: { type: "object" },
          },
        },
      ],
      undefined,
      undefined,
      { recordDurationMetadata: false },
    );

    const result = (await tool.execute(
      "client-call-2",
      {},
      undefined,
      undefined,
      extensionContext,
    )) as TimedAgentToolResult;

    const details = result.details as { metadata?: { durationMs?: number } } | undefined;
    expect(details?.metadata?.durationMs).toBeUndefined();
  });

  it("does not mutate the original result.details object", async () => {
    const originalDetails: { status: string; metadata?: Record<string, unknown> } = {
      status: "completed",
      metadata: { source: "tool" },
    };
    const tool = {
      name: "immutable",
      label: "Immutable",
      description: "returns shared details",
      parameters: emptySchema,
      execute: async () =>
        ({
          content: [{ type: "text", text: "done" }],
          details: originalDetails,
        }) as unknown as AgentToolResult<unknown>,
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool]);
    const result = (await defs[0].execute(
      "call-immutable",
      {},
      undefined,
      undefined,
      extensionContext,
    )) as TimedAgentToolResult;

    expect(originalDetails.metadata?.durationMs).toBeUndefined();
    expect((result.details as { metadata?: { durationMs?: number } }).metadata?.durationMs).toBe(
      result.durationMs,
    );
  });
});
