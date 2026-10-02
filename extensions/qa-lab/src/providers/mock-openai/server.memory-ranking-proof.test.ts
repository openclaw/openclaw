import { expect, it } from "vitest";
import {
  createMockServerTestHarness,
  expectOpenAiNonStreamingResponsesJson,
  makeUserInput,
  makeToolOutputWithCallId,
  outputToolArgsFromItem,
  outputToolCall,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

it("plans an answer-free search across both configured memory sources", async () => {
  const payload = await expectOpenAiNonStreamingResponsesJson(await startMockServer(), {
    input: [
      makeUserInput(
        "Session memory ranking check: what is the current Project Nebula codename? Use memory tools first.",
      ),
    ],
  });
  const args = outputToolArgsFromItem(outputToolCall(payload, "memory_search"));
  expect(args).toEqual({ query: "current Project Nebula codename", maxResults: 6 });
  expect(JSON.stringify(args)).not.toMatch(/ORBIT-(?:9|10)/);
  expect(args).not.toHaveProperty("corpus");
});

it("preserves memory retrieval line selection", async () => {
  const server = await startMockServer();
  for (const [range, from] of [
    [{ endLine: 7 }, 7],
    [{ endLine: 0 }, 1],
    [{ startLine: 0, endLine: 9 }, 1],
  ] as const) {
    const payload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [{ type: "function", name: "memory_get", parameters: { type: "object" } }],
      input: [
        makeUserInput("Memory tools check: read the hidden project codename."),
        makeToolOutputWithCallId(
          "call_memory_search",
          JSON.stringify({ results: [{ path: "MEMORY.md", ...range }] }),
        ),
      ],
    });
    expect(outputToolArgsFromItem(outputToolCall(payload, "memory_get"))).toEqual({
      path: "MEMORY.md",
      from,
      lines: 4,
    });
  }
});
