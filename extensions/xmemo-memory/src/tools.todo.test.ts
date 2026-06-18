import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerXMemoTools } from "./tools.js";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("xmemo_todo_list tool", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const tools = new Map<string, { execute: (toolCallId: string, params: unknown) => unknown }>();

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    tools.clear();
    process.env.XMEMO_KEY = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.XMEMO_KEY;
  });

  function mockApi(): OpenClawPluginApi {
    return {
      config: {
        plugins: {
          entries: {
            "xmemo-memory": {
              config: {
                apiKey: "test-key",
                bucket: "openclaw",
              },
            },
          },
        },
      },
      registerTool: (
        definition: { name: string; execute: (toolCallId: string, params: unknown) => unknown },
        _opts?: unknown,
      ) => {
        tools.set(definition.name, definition);
      },
    } as unknown as OpenClawPluginApi;
  }

  it("unwraps the real XMemo reminder list response shape", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        reminders: [
          { id: "r-1", content: "task one", status: "open" },
          { id: "r-2", content: "task two", status: "open", due_at: "2026-06-20T00:00:00Z" },
        ],
      }),
    );

    registerXMemoTools(mockApi());
    const tool = tools.get("xmemo_todo_list");
    expect(tool).toBeDefined();

    const result = await tool!.execute("call-1", { status: "open" });
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: "XMemo reminders:\n\n1. task one\n2. task two (due 2026-06-20T00:00:00Z)",
        },
      ],
      details: { count: 2 },
    });

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get("item_status")).toBe("open");
  });
});
