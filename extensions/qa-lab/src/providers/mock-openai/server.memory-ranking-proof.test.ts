import { describe, expect, it } from "vitest";
import { startQaMockOpenAiServer } from "./server.js";

describe("QA mock OpenAI session memory ranking", () => {
  it("plans an answer-free search across both configured memory sources", async () => {
    const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });

    try {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          stream: false,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Session memory ranking check: what is the current Project Nebula codename? Use memory tools first.",
                },
              ],
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        output?: Array<{ type?: string; name?: string; arguments?: string }>;
      };
      const searchCall = payload.output?.find(
        (item) => item.type === "function_call" && item.name === "memory_search",
      );
      expect(searchCall).toBeDefined();
      const args = JSON.parse(searchCall?.arguments ?? "null") as Record<string, unknown>;

      expect(args).toEqual({
        query: "current Project Nebula codename",
        maxResults: 6,
      });
      expect(JSON.stringify(args)).not.toMatch(/ORBIT-(?:9|10)/);
      expect(args).not.toHaveProperty("corpus");
    } finally {
      await server.stop();
    }
  });
});

describe("QA mock OpenAI memory_get arguments", () => {
  it.each([
    ["memory tools", "Memory tools check: read the hidden project codename."],
    ["session ranking", "Session memory ranking check: read the current Project Nebula codename."],
    ["thread recall", "Thread memory check: read the hidden thread codename."],
    [
      "snack recall",
      "You are a memory search agent. Silent snack recall check: what snack do I usually want?",
    ],
  ])("preserves retrieval line selection for %s", async (_name, prompt) => {
    const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
    try {
      for (const [range, from] of [
        [{ endLine: 7 }, 7],
        [{ endLine: 0 }, 1],
        [{ startLine: 0, endLine: 9 }, 1],
      ] as const) {
        const response = await fetch(`${server.baseUrl}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-5.6-luna",
            stream: false,
            tools: [{ type: "function", name: "memory_get", parameters: { type: "object" } }],
            input: [
              { role: "user", content: [{ type: "input_text", text: prompt }] },
              {
                type: "function_call_output",
                call_id: "call_memory_search",
                output: JSON.stringify({ results: [{ path: "MEMORY.md", ...range }] }),
              },
            ],
          }),
        });
        expect(response.status).toBe(200);
        const payload = (await response.json()) as {
          output?: Array<{ type?: string; name?: string; arguments?: string }>;
        };
        const call = payload.output?.find(
          (item) => item.type === "function_call" && item.name === "memory_get",
        );
        expect(JSON.parse(call?.arguments ?? "null")).toEqual({
          path: "MEMORY.md",
          from,
          lines: 4,
        });
      }
    } finally {
      await server.stop();
    }
  });
});
