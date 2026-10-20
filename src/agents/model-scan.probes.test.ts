import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const scan = () => scanOpenRouterModels({ apiKey: "synthetic-test-key" });
const latencyMs = expect.any(Number);
const probeOptions = {
  apiKey: "synthetic-test-key",
  temperature: 0,
  signal: expect.any(AbortSignal),
};
function userMessage(content: unknown) {
  return { role: "user", content, timestamp: expect.any(Number) };
}

describe("OpenRouter model probes", () => {
  beforeEach(() => {
    complete.mockReset();
    vi.stubGlobal("fetch", fetchImpl);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("preserves tool and image probe requests and reports each result", async () => {
    complete.mockResolvedValueOnce({ content: [{ type: "toolCall" }] });
    complete.mockResolvedValueOnce({ content: [{ type: "text", text: "OK" }] });

    const [result] = await scan();

    expect([result?.tool, result?.image]).toEqual([
      { ok: true, latencyMs },
      { ok: true, latencyMs },
    ]);
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
      messages: [userMessage("Call the ping tool with {} and nothing else.")],
      tools: [
        { name: "ping", description: "Return OK.", parameters: { type: "object", properties: {} } },
      ],
    });
    expect(imageContext).toEqual({
      messages: [
        userMessage([
          { type: "text", text: "Reply with OK." },
          {
            type: "image",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=",
            mimeType: "image/png",
          },
        ]),
      ],
    });
    expect(toolOptions).toEqual({
      ...probeOptions,
      maxTokens: 256,
      toolChoice: "required",
    });
    expect(imageOptions).toEqual({ ...probeOptions, maxTokens: 16 });
  });

  it("continues to image probing after a missing tool call and reports image errors", async () => {
    complete.mockResolvedValueOnce({ content: [{ type: "text", text: "OK" }] });
    complete.mockRejectedValueOnce(new Error("image rejected"));

    const [result] = await scan();

    expect([result?.tool, result?.image]).toEqual([
      { ok: false, latencyMs, error: "No tool call returned" },
      { ok: false, latencyMs, error: "image rejected" },
    ]);
  });
});
