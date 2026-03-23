import { describe, test, expect, vi, beforeEach } from "vitest";
import memoryPlugin from "./index.js";

const embedMock = vi.fn().mockResolvedValue(new Array(3072).fill(0));

vi.mock("./embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embeddings.js")>();
  return {
    ...actual,
    Embeddings: class {
      embed = embedMock;
    },
  };
});

// Also mock MemoryDB to avoid LanceDB issues in test
vi.mock("./index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./index.js")>();
  return {
    ...actual,
    MemoryDB: class {
      searchWithAMHR = vi.fn().mockResolvedValue([]);
    },
  };
});

describe("plugin before_agent_start hook", () => {
  let hookHandler: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    const mockApi: any = {
      pluginConfig: {
        embedding: { apiKey: "test-key" },
      },
      resolvePath: (p: string) => `/tmp/${p}`,
      logger: { warn: vi.fn(), info: vi.fn() },
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn(),
      on: (hook: string, fn: any) => {
        if (hook === "before_agent_start") hookHandler = fn;
      },
    };

    await memoryPlugin.register!(mockApi);
    expect(hookHandler).toBeDefined();
  });

  test("should skip memory search for system triggers even with long prompts", async () => {
    // 🔴 RED Stage test: It currently DOES call the embeddings, because it ignores trigger.
    await hookHandler(
      { prompt: "System: Generating an automated greeting for the user." },
      { trigger: "system", channelId: "tg" },
    );

    // We expect it to short-circuit and NOT call embed
    expect(embedMock).not.toHaveBeenCalled();
  });
});
