import { jsonResponse, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeExecutionTool } from "./code-execution.js";
import { createXaiFetchInspectors } from "./responses-http.test-support.js";

const { firstFetchUrl, firstAuthorizationHeader, parseFirstRequestBody } =
  createXaiFetchInspectors("code_execution");

function configuredTool(codeExecution?: {
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
}) {
  const config = {
    webSearch: { apiKey: "xai-plugin-key" }, // pragma: allowlist secret
    ...(codeExecution ? { codeExecution } : {}),
  };
  return createCodeExecutionTool({ config: { plugins: { entries: { xai: { config } } } } });
}

function outputText(text: string, ...urls: string[]) {
  return {
    type: "output_text",
    text,
    ...(urls.length ? { annotations: urls.map((url) => ({ type: "url_citation", url })) } : {}),
  };
}

function installCodeExecutionFetch(
  payload: Record<string, unknown> = {
    output: [
      { type: "code_interpreter_call" },
      { type: "message", content: [outputText("Mean: 42", "https://example.com/data.csv")] },
    ],
    citations: ["https://example.com/data.csv"],
  },
) {
  const mockFetch = vi.fn((_input?: unknown, _init?: RequestInit) =>
    Promise.resolve(jsonResponse(payload)),
  );
  vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
  return mockFetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("xai code_execution tool", () => {
  it("enables code_execution from an xAI auth profile and uses it for requests", async () => {
    const mockFetch = installCodeExecutionFetch();
    const tool = createCodeExecutionTool({
      config: {},
      auth: {
        hasAuthForProvider: (providerId) => providerId === "xai",
        resolveApiKeyForProvider: async (providerId) =>
          providerId === "xai" ? "xai-profile-key" : undefined, // pragma: allowlist secret
      },
    });

    expect(tool?.name).toBe("code_execution");
    await tool?.execute?.("code-execution:auth-profile", {
      task: "Sum [20, 22]",
    });

    expect(firstAuthorizationHeader(mockFetch)).toBe("Bearer xai-profile-key");
  });

  it("requests code_interpreter and returns every answer and citation", async () => {
    const mockFetch = installCodeExecutionFetch({
      output: [
        { type: "code_interpreter_call" },
        {
          type: "message",
          content: [
            outputText("Mean: ", "https://example.com/input.csv"),
            outputText("42", "https://example.com/result.csv", "https://example.com/input.csv"),
          ],
        },
        {
          type: "message",
          content: [outputText(". Verified.")],
        },
      ],
    });
    const tool = configuredTool({ maxTurns: 2, timeoutSeconds: 45 });

    const result = await tool?.execute?.("code-execution:multi-block", {
      task: "Calculate and verify the mean.",
    });

    expect(firstFetchUrl(mockFetch)).toContain("api.x.ai/v1/responses");
    const body = parseFirstRequestBody(mockFetch);
    expect(body).toMatchObject({ model: "grok-4.7", store: false, max_turns: 2 });
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.tools).toEqual([{ type: "code_interpreter" }]);
    expect(result?.details).toMatchObject({
      content: "Mean: 42. Verified.",
      citations: ["https://example.com/input.csv", "https://example.com/result.csv"],
      usedCodeExecution: true,
    });
  });

  it("reuses the xAI plugin web search key without overriding custom model reasoning", async () => {
    const mockFetch = installCodeExecutionFetch();
    const tool = configuredTool({ model: "grok-build-0.1" });

    await tool?.execute?.("code-execution:plugin-key", {
      task: "Compute the standard deviation of [1, 2, 3]",
    });

    expect(firstAuthorizationHeader(mockFetch)).toBe("Bearer xai-plugin-key");
    const body = parseFirstRequestBody(mockFetch);
    expect(body.model).toBe("grok-build-0.1");
    expect(body.input).toEqual([
      { role: "user", content: "Compute the standard deviation of [1, 2, 3]" },
    ]);
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("max_turns");
  });

  it("reports missing code_execution answers without blaming JSON decoding", async () => {
    installCodeExecutionFetch({
      status: "incomplete",
      output: [{ type: "code_interpreter_call" }],
    });
    const tool = configuredTool();

    await expect(
      tool?.execute?.("code-execution:missing-text", {
        task: "Calculate the mean of [40, 42, 44]",
      }),
    ).rejects.toThrow("xAI code execution failed: no answer text returned; try a simpler request");
  });
});
