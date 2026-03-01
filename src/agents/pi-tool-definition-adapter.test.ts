import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import { toClientToolDefinitions, toToolDefinitions } from "./pi-tool-definition-adapter.js";

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

async function executeThrowingTool(name: string, callId: string) {
  const tool = {
    name,
    label: name === "bash" ? "Bash" : "Boom",
    description: "throws",
    parameters: Type.Object({}),
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

async function executeTool(tool: AgentTool, callId: string) {
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

  it("coerces details-only tool results to include content", async () => {
    const tool = {
      name: "memory_query",
      label: "Memory Query",
      description: "returns details only",
      parameters: Type.Object({}),
      execute: (async () => ({
        details: {
          hits: [{ id: "a1", score: 0.9 }],
        },
      })) as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call3");
    expect(result.details).toEqual({
      hits: [{ id: "a1", score: 0.9 }],
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text?: string }).text).toContain('"hits"');
  });

  it("coerces non-standard object results to include content", async () => {
    const tool = {
      name: "memory_query_raw",
      label: "Memory Query Raw",
      description: "returns plain object",
      parameters: Type.Object({}),
      execute: (async () => ({
        count: 2,
        ids: ["m1", "m2"],
      })) as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call4");
    expect(result.details).toEqual({
      count: 2,
      ids: ["m1", "m2"],
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text?: string }).text).toContain('"count"');
  });

  it("compacts nested tool parameter schema metadata without mutating the source schema", () => {
    const parameters = Type.Object(
      {
        action: Type.Union([Type.Literal("send"), Type.Literal("edit")], {
          title: "Action title",
          description: "Action description",
        }),
        payload: Type.Object(
          {
            message: Type.String({ title: "Message title", description: "Message description" }),
          },
          { description: "Payload description" },
        ),
        title: Type.String({ title: "Field title", description: "Field description meta" }),
        description: Type.String({
          title: "Description field title",
          description: "Description field meta",
        }),
      },
      { title: "Top title", description: "Top level description" },
    );
    const originalParameters = JSON.parse(JSON.stringify(parameters));
    const tool = {
      name: "compact_me",
      label: "compact_me",
      description: "test compact tool",
      parameters,
      execute: (async () => ({ details: { ok: true } })) as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const [def] = toToolDefinitions([tool]);
    expect(def).toBeDefined();
    expect(def?.parameters).toMatchObject({
      type: "object",
      description: "Top level description",
      properties: {
        action: {
          anyOf: [
            { const: "send", type: "string" },
            { const: "edit", type: "string" },
          ],
        },
        payload: {
          type: "object",
          properties: {
            message: {
              type: "string",
            },
          },
        },
        title: {
          type: "string",
        },
        description: {
          type: "string",
        },
      },
    });
    const compactedSchemaJson = JSON.stringify(def?.parameters);
    expect(compactedSchemaJson).not.toContain("Action title");
    expect(compactedSchemaJson).not.toContain("Action description");
    expect(compactedSchemaJson).not.toContain("Message title");
    expect(compactedSchemaJson).not.toContain("Message description");
    expect(compactedSchemaJson).not.toContain("Field title");
    expect(compactedSchemaJson).not.toContain("Field description meta");
    const compactedParameters = def?.parameters as Record<string, unknown>;
    expect(compactedParameters).not.toHaveProperty("title");
    expect(compactedParameters).toHaveProperty("properties.title.type", "string");
    expect(compactedParameters).toHaveProperty("properties.description.type", "string");
    expect(compactedParameters).not.toHaveProperty("properties.title.title");
    expect(compactedParameters).not.toHaveProperty("properties.description.title");
    expect(JSON.parse(JSON.stringify(parameters))).toEqual(originalParameters);
  });

  it("compacts nested client tool schemas before exposing definitions", () => {
    const clientTools: ClientToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "client_compact_me",
          description: "client tool",
          parameters: {
            type: "object",
            title: "Client top title",
            description: "Client top description",
            properties: {
              query: {
                type: "string",
                title: "Query title",
                description: "Query description",
              },
              title: {
                type: "string",
                title: "Client field title",
                description: "Client field title description",
              },
              description: {
                type: "string",
                title: "Client description field title",
                description: "Client description field description",
              },
            },
            required: ["query"],
          },
        },
      },
    ];

    const [tool] = toClientToolDefinitions(clientTools);
    expect(tool).toBeDefined();
    expect(tool?.parameters).toEqual({
      type: "object",
      description: "Client top description",
      properties: {
        query: {
          type: "string",
        },
        title: {
          type: "string",
        },
        description: {
          type: "string",
        },
      },
      required: ["query"],
    });
  });
});
