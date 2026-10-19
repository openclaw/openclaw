import {
  createCapturedPluginRegistration,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { executePortableResearch } from "./portable-tool.js";

function fixture() {
  const runtime = createPluginRuntimeMock();
  const complete = vi.mocked(runtime.llm.complete);
  const responses = [
    { questions: ["river length"] },
    {
      findings: [
        {
          statement: "The river is 12 km long.",
          evidence: [{ sourceId: "S1", quote: "The measured river length is 12 km." }],
        },
      ],
      gaps: [],
      queries: [],
    },
    {
      verdicts: [
        { index: 0, verdict: "supported", reason: "The cited passage states the measured length." },
      ],
      unanswered: [],
    },
  ];
  complete.mockImplementation(async () => ({
    text: JSON.stringify(responses.shift()),
    provider: "example",
    model: "research-model",
    agentId: "main",
    usage: { totalTokens: 30 },
    execution: { mode: "direct-provider", owner: { kind: "provider", id: "example" } },
    audit: { caller: { kind: "plugin", id: "deep-research" } },
  }));
  const request = vi.mocked(runtime.gateway.request);
  request.mockResolvedValueOnce({
    ok: true,
    output: { details: { results: [{ url: "https://example.org/river", title: "River" }] } },
  });
  request.mockResolvedValueOnce({
    ok: true,
    output: {
      details: { url: "https://example.org/river", text: "The measured river length is 12 km." },
    },
  });
  const api = { ...createCapturedPluginRegistration({ id: "deep-research" }).api, runtime };
  const current = vi.fn();
  const context = {
    sessionKey: "agent:main:research-fixture",
    sessionId: "generation-1",
    agentId: "main",
    assertInvocationCurrent: current,
  };
  const tool = {
    execute: (_id: string, input: { question: string }) =>
      executePortableResearch(api, context, input),
  };
  return { tool, complete, request, current };
}

describe("deep research tool", () => {
  it("uses direct completions and policy-checked tools in the originating session", async () => {
    const { tool, complete, request } = fixture();
    const output = await tool.execute("call-1", { question: "How long is the river?" });
    expect(output).toMatchObject({
      status: "completed",
      route: { model: "example/research-model", runtime: "direct-provider" },
    });
    expect(complete.mock.calls.every(([input]) => input.execution === undefined)).toBe(true);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "tools.invoke",
      {
        name: "web_search",
        args: { query: "river length", count: 5 },
        sessionKey: "agent:main:research-fixture",
        agentId: "main",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "tools.invoke",
      {
        name: "web_fetch",
        args: { url: "https://example.org/river", extractMode: "text", maxChars: 12_000 },
        sessionKey: "agent:main:research-fixture",
        agentId: "main",
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("does not fetch or publish when authority is revoked during search", async () => {
    const { tool, request, current } = fixture();
    request.mockReset();
    request.mockImplementationOnce(async () => {
      current.mockImplementation(() => {
        throw new Error("revoked");
      });
      return { ok: true, output: { details: { results: [{ url: "https://example.org/river" }] } } };
    });
    await expect(tool.execute("call-1", { question: "River length" })).rejects.toThrow("revoked");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
