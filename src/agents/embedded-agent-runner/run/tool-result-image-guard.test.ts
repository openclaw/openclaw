import { describe, expect, it } from "vitest";
import type { AfterToolCallContext, Agent } from "../../runtime/index.js";
import { installToolResultImageSanitizerHook } from "./tool-result-image-guard.js";

function makeContext(content: unknown[]): AfterToolCallContext {
  return {
    toolCall: { id: "call_1", name: "some_tool", arguments: {} },
    args: {},
    result: { content, details: {} },
    isError: false,
  } as unknown as AfterToolCallContext;
}

function makeAgent(): Agent {
  return { afterToolCall: undefined } as unknown as Agent;
}

describe("installToolResultImageSanitizerHook", () => {
  it("neutralizes husk image blocks from tools without their own sanitization (#99370 class)", async () => {
    const agent = makeAgent();
    installToolResultImageSanitizerHook({ agent });

    const hookResult = await agent.afterToolCall?.(
      makeContext([
        { type: "text", text: "fetched" },
        { type: "image", data: "", mimeType: "image/png" },
      ]),
    );

    expect(hookResult?.content).toEqual([
      { type: "text", text: "fetched" },
      { type: "text", text: "[tool:some_tool] omitted empty image payload" },
    ]);
  });

  it("rewrites image blocks missing data or mimeType to text fallbacks", async () => {
    const agent = makeAgent();
    installToolResultImageSanitizerHook({ agent });

    const hookResult = await agent.afterToolCall?.(makeContext([{ type: "image" }]));

    expect(hookResult?.content).toEqual([
      { type: "text", text: "[tool:some_tool] omitted image payload: missing data or mimeType" },
    ]);
  });

  it("sanitizes extension-modified content, not the original result", async () => {
    const agent = makeAgent();
    agent.afterToolCall = async () => ({
      content: [{ type: "image", data: "", mimeType: "image/png" }],
      isError: true,
    });
    installToolResultImageSanitizerHook({ agent });

    const hookResult = await agent.afterToolCall?.(
      makeContext([{ type: "text", text: "original untouched" }]),
    );

    expect(hookResult?.content).toEqual([
      { type: "text", text: "[tool:some_tool] omitted empty image payload" },
    ]);
    expect(hookResult?.isError).toBe(true);
  });

  it("returns no override when there is nothing to sanitize and no prior hook result", async () => {
    const agent = makeAgent();
    installToolResultImageSanitizerHook({ agent });

    const hookResult = await agent.afterToolCall?.(
      makeContext([{ type: "resource", uri: "https://example.com" }]),
    );

    expect(hookResult).toBeUndefined();
  });

  it("passes clean text content through unchanged", async () => {
    const agent = makeAgent();
    installToolResultImageSanitizerHook({ agent });

    const hookResult = await agent.afterToolCall?.(makeContext([{ type: "text", text: "ok" }]));

    expect(hookResult?.content).toEqual([{ type: "text", text: "ok" }]);
  });
});
