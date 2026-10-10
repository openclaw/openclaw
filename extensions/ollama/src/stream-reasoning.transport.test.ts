import type { Model } from "openclaw/plugin-sdk/llm";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const { guardedFetch } = vi.hoisted(() => ({
  guardedFetch: vi.fn<typeof fetchWithSsrFGuard>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: guardedFetch,
}));

import { createOllamaStreamFn } from "./stream.runtime.js";

afterEach(() => guardedFetch.mockReset());

describe("native Ollama direct completion reasoning", () => {
  it.each([
    ["explicit off", {}, "off", false],
    ["omitted reasoning", {}, undefined, undefined],
    ["configured think", { params: { think: true } }, "off", true],
    ["configured thinking alias", { params: { thinking: "medium" } }, "off", "medium"],
    ["think over thinking", { params: { think: false, thinking: "medium" } }, "off", false],
    ["non-thinking model", { reasoning: false }, "off", false],
    [
      "unsupported configured thinking",
      { reasoning: false, params: { think: true } },
      "off",
      false,
    ],
    ["Cloud model thinking floor", { id: "glm-5.3:cloud" }, "off", "low"],
  ] as const)("serializes %s", async (_name, overrides, reasoning, expectedThink) => {
    guardedFetch.mockResolvedValue({
      finalUrl: "http://localhost:11434/api/chat",
      response: new Response(
        JSON.stringify({
          model: "qwen3:4b",
          message: { role: "assistant", content: "ok" },
          done: true,
          done_reason: "stop",
        }) + "\n",
      ),
      release: async () => {},
    });
    const model: Model = {
      api: "ollama",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      id: "qwen3:4b",
      name: "Qwen3 4B",
      reasoning: true,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...overrides,
    };
    const stream = await createOllamaStreamFn("http://localhost:11434")(
      model,
      { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
      { maxTokens: 24, ...(reasoning === undefined ? {} : { reasoning }) },
    );
    expect((await stream.result()).stopReason).toBe("stop");
    expect(guardedFetch).toHaveBeenCalledOnce();
    const body = guardedFetch.mock.calls[0]?.[0].init?.body;
    if (typeof body !== "string") {
      throw new Error("Expected serialized native Ollama request");
    }
    const request = JSON.parse(body);
    expect(request.think).toBe(expectedThink);
    expect(request.options).toMatchObject({ num_predict: 24 });
    expect(request.options).not.toHaveProperty("think");
  });
});
