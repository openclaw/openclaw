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
function probeCall(model: unknown, content: unknown, options: object, tools?: object[]) {
  return [
    model,
    {
      messages: [{ role: "user", content, timestamp: expect.any(Number) }],
      ...(tools ? { tools } : {}),
    },
    { ...probeOptions, ...options },
  ];
}
const ping = {
  name: "ping",
  description: "Return OK.",
  parameters: { type: "object", properties: {} },
};

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
    const [model] = expectDefined(complete.mock.calls[0], "tool probe call");
    expect(complete.mock.calls).toEqual([
      probeCall(
        model,
        "Call the ping tool with {} and nothing else.",
        { maxTokens: 256, toolChoice: "required" },
        [ping],
      ),
      probeCall(
        model,
        [
          { type: "text", text: "Reply with OK." },
          {
            type: "image",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=",
            mimeType: "image/png",
          },
        ],
        { maxTokens: 16 },
      ),
    ]);
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
