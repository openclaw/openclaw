import type { Model } from "openclaw/plugin-sdk/llm";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { requestBodyText } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn<typeof fetchWithSsrFGuard>() }));
// mock-isolation: Capture native HTTP payloads without DNS or network activity.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: fetchMock }));

import { buildOllamaModelDefinition } from "./provider-models.js";
import { createOllamaStreamFn } from "./stream.runtime.js";

const baseModel: Model = {
  id: "local-model",
  name: "Local model",
  provider: "custom-ollama",
  api: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("native Ollama output guards", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      finalUrl: "http://127.0.0.1:11434/api/chat",
      response: new Response(
        JSON.stringify({
          model: "local-model",
          message: { role: "assistant", content: "ok" },
          done: true,
        }) + "\n",
      ),
      release: async () => {},
    });
  });

  it.each<{
    name: string;
    model?: Partial<Model>;
    maxTokens?: number;
    expected: number;
  }>([
    { name: "resolved model cap", model: { maxTokens: 3072 }, expected: 3072 },
    { name: "authored native cap", model: { params: { num_predict: 123 } }, expected: 123 },
    { name: "authored unlimited sentinel", model: { params: { num_predict: -1 } }, expected: -1 },
    {
      name: "explicit runtime cap over authored defaults",
      model: { maxTokens: 3072, params: { num_predict: 123 } },
      maxTokens: 55,
      expected: 55,
    },
    {
      name: "explicit runtime cap above model metadata",
      model: { maxTokens: 3072 },
      maxTokens: 4096,
      expected: 4096,
    },
  ])("sends $name as num_predict", async ({ model: overrides, maxTokens, expected }) => {
    const model = { ...baseModel, ...overrides };
    const stream = await createOllamaStreamFn(model.baseUrl)(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { maxTokens },
    );
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "stop" });
    const request = fetchMock.mock.calls[0]?.[0];
    expect(request?.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(JSON.parse(requestBodyText(request?.init?.body))).toMatchObject({
      options: { num_predict: expected },
    });
  });

  it.each(["minimax-m3", "kimi-k3"])(
    "sends the local default for a bare %s catalog collision",
    async (id) => {
      const definition = buildOllamaModelDefinition(id);
      const model = { ...baseModel, id, maxTokens: definition.maxTokens };
      const stream = await createOllamaStreamFn(model.baseUrl)(model, {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      });
      await stream.result();
      expect(JSON.parse(requestBodyText(fetchMock.mock.calls[0]?.[0].init?.body))).toMatchObject({
        options: { num_predict: 8192 },
      });
    },
  );

  it("replays preserved blocks and the repetition marker through the native request", async () => {
    const stream = await createOllamaStreamFn(baseModel.baseUrl)(baseModel, {
      messages: [
        { role: "user", content: "start", timestamp: 1 },
        {
          role: "assistant",
          api: baseModel.api,
          provider: baseModel.provider,
          model: baseModel.id,
          content: [
            { type: "text", text: "Earlier answer stays intact." },
            { type: "text", text: "[Repetitive output stopped]" },
          ],
          stopReason: "error",
          errorCode: "openclaw_repetitive_output",
          timestamp: 2,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
        { role: "user", content: "next", timestamp: 3 },
      ],
    });
    await stream.result();
    expect(JSON.parse(requestBodyText(fetchMock.mock.calls[0]?.[0].init?.body)).messages).toEqual([
      { role: "user", content: "start" },
      { role: "assistant", content: "Earlier answer stays intact.[Repetitive output stopped]" },
      { role: "user", content: "next" },
    ]);
  });
});
