import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverCopilotModels } from "./discovery.js";

describe("discoverCopilotModels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches Copilot models with IDE and configured headers", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "zeta-model",
              name: "Zeta",
              capabilities: {
                type: "chat",
                limits: { max_prompt_tokens: 64_000, max_output_tokens: 4096 },
                supports: { reasoning: true },
              },
              policy: { state: "enabled" },
            },
            {
              id: "known-model",
              capabilities: { type: "chat" },
              policy: { state: "enabled" },
            },
            {
              id: "alpha-model",
              capabilities: { type: "chat" },
              policy: { state: "enabled" },
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverCopilotModels({
        baseUrl: "https://copilot.example.com/",
        copilotToken: "copilot-token",
        knownModelIds: new Set(["known-model"]),
        extraHeaders: { "X-Proxy-Auth": "proxy-token" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "alpha-model" }),
      expect.objectContaining({
        id: "zeta-model",
        name: "Zeta",
        reasoning: true,
        contextWindow: 64_000,
        maxTokens: 4096,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://copilot.example.com/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer copilot-token",
          "Copilot-Integration-Id": "vscode-chat",
          "X-Proxy-Auth": "proxy-token",
        }),
      }),
    );
  });
});
