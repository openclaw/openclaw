import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Model } from "../../../llm-core/src/index.js";
import type { AgentTool } from "../types.js";
import { AgentHarness } from "./agent-harness.js";
import { InMemorySessionRepo } from "./session/memory-repo.js";
import { AgentHarnessError, type ExecutionEnv, type Session } from "./types.js";

function createEnv(): ExecutionEnv {
  return { cwd: "/workspace" } as ExecutionEnv;
}

function createModel(): Model {
  return {
    provider: "test-provider",
    id: "test-model",
    api: "openai-responses",
  } as Model;
}

function createTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "Test tool.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  };
}

async function createSession(): Promise<Session> {
  return new InMemorySessionRepo().create({ id: "session-1" });
}

async function createHarness(tools: AgentTool[]): Promise<AgentHarness> {
  return new AgentHarness({
    env: createEnv(),
    session: await createSession(),
    model: createModel(),
    tools,
  });
}

describe("AgentHarness tool registration", () => {
  it("rejects tool definitions with non-string names", async () => {
    const create = createHarness([
      {
        ...createTool("valid"),
        name: 42,
      } as never,
    ]);

    await expect(create).rejects.toThrow("Agent tool name must be a non-empty string");
    await expect(create).rejects.toMatchObject({
      code: "invalid_argument",
    } satisfies Partial<AgentHarnessError>);
  });

  it("wraps unreadable tool name accessors with a harness error", async () => {
    const create = createHarness([
      {
        ...createTool("valid"),
        get name(): never {
          throw new Error("tool name getter exploded");
        },
      },
    ]);

    await expect(create).rejects.toThrow("Agent tool name must be readable");
    await expect(create).rejects.toMatchObject({
      code: "invalid_argument",
    } satisfies Partial<AgentHarnessError>);
  });

  it("reads constructor tool names once while building the registry", async () => {
    let reads = 0;
    const tool: AgentTool = {
      ...createTool("valid"),
      get name(): string {
        reads += 1;
        if (reads > 1) {
          throw new Error("tool name read twice");
        }
        return "single_read";
      },
    };

    await expect(createHarness([tool])).resolves.toBeInstanceOf(AgentHarness);
    expect(reads).toBe(1);
  });

  it("rejects malformed replacement tool names without changing the harness", async () => {
    const harness = await createHarness([createTool("valid")]);

    await expect(
      harness.setTools([
        {
          ...createTool("bad"),
          name: 42,
        } as never,
      ]),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      message: "Agent tool name must be a non-empty string",
    } satisfies Partial<AgentHarnessError>);

    await expect(harness.setTools([createTool("replacement")], ["replacement"])).resolves.toBe(
      undefined,
    );
  });
});
