import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { scanOpenRouterModels } from "./model-scan.js";

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@openclaw/ai", () => ({
  createLlmRuntime: () => ({ complete, registry: {} }),
  configureAiTransportHost: vi.fn(),
}));
vi.mock("@openclaw/ai/providers", () => ({ registerBuiltInApiProviders: vi.fn() }));

const fetchImpl = withFetchPreconnect(async () =>
  Response.json({ data: [{ id: "example/vision:free", modality: "text+image" }] }),
);

describe("OpenRouter model probes", () => {
  beforeEach(() => {
    complete.mockReset();
  });

  it("preserves tool and image probe requests and reports each result", async () => {
    complete.mockResolvedValueOnce({ content: [{ type: "toolCall" }] });
    complete.mockResolvedValueOnce({ content: [{ type: "text", text: "OK" }] });

    const [result] = await scanOpenRouterModels({ fetchImpl, apiKey: "synthetic-test-key" });

    expect(result?.tool).toEqual({ ok: true, latencyMs: expect.any(Number) });
    expect(result?.image).toEqual({ ok: true, latencyMs: expect.any(Number) });
    expect(complete).toHaveBeenCalledTimes(2);
    const [toolModel, toolContext, toolOptions] = expectDefined(
      complete.mock.calls[0],
      "tool probe call",
    );
    const [imageModel, imageContext, imageOptions] = expectDefined(
      complete.mock.calls[1],
      "image probe call",
    );
    expect(imageModel).toEqual(toolModel);
    expect(toolContext).toEqual({
      messages: [
        {
          role: "user",
          content: "Call the ping tool with {} and nothing else.",
          timestamp: expect.any(Number),
        },
      ],
      tools: [
        { name: "ping", description: "Return OK.", parameters: { type: "object", properties: {} } },
      ],
    });
    expect(imageContext).toEqual({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Reply with OK." },
            {
              type: "image",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=",
              mimeType: "image/png",
            },
          ],
          timestamp: expect.any(Number),
        },
      ],
    });
    expect(toolOptions).toEqual({
      apiKey: "synthetic-test-key",
      maxTokens: 256,
      temperature: 0,
      toolChoice: "required",
      signal: expect.any(AbortSignal),
    });
    expect(imageOptions).toEqual({
      apiKey: "synthetic-test-key",
      maxTokens: 16,
      temperature: 0,
      signal: expect.any(AbortSignal),
    });
  });

  it("continues to image probing after a missing tool call and reports image errors", async () => {
    complete.mockResolvedValueOnce({ content: [{ type: "text", text: "OK" }] });
    complete.mockRejectedValueOnce(new Error("image rejected"));

    const [result] = await scanOpenRouterModels({ fetchImpl, apiKey: "synthetic-test-key" });

    expect(result?.tool).toEqual({
      ok: false,
      latencyMs: expect.any(Number),
      error: "No tool call returned",
    });
    expect(result?.image).toEqual({
      ok: false,
      latencyMs: expect.any(Number),
      error: "image rejected",
    });
  });
});
