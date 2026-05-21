import type { Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const streamSimpleMock = vi.fn();
const sanitizeGoogleThinkingPayloadMock = vi.fn();
const ensureCustomApiRegisteredMock = vi.fn();

vi.mock("@earendil-works/pi-ai", async () => {
  const actual =
    await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  return {
    ...actual,
    streamSimple: streamSimpleMock,
  };
});

vi.mock("../plugin-sdk/provider-stream-shared.js", async () => {
  const actual = await vi.importActual<
    typeof import("../plugin-sdk/provider-stream-shared.js")
  >("../plugin-sdk/provider-stream-shared.js");
  return {
    ...actual,
    sanitizeGoogleThinkingPayload: sanitizeGoogleThinkingPayloadMock,
  };
});

vi.mock("./custom-api-registry.js", () => ({
  ensureCustomApiRegistered: ensureCustomApiRegisteredMock,
}));

const {
  GOOGLE_SIMPLE_COMPLETION_API,
  prepareGoogleSimpleCompletionModel,
} = await import("./google-simple-completion-stream.js");

function makeModel(id: string): Model<"google-generative-ai"> {
  return {
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 8192,
    headers: {},
  };
}

describe("prepareGoogleSimpleCompletionModel", () => {
  beforeEach(() => {
    streamSimpleMock.mockReset();
    sanitizeGoogleThinkingPayloadMock.mockReset();
    ensureCustomApiRegisteredMock.mockReset();
    ensureCustomApiRegisteredMock.mockReturnValue(true);
    // Default: capture onPayload invocation by invoking it immediately with the
    // raw payload pi-ai would normally produce.
    streamSimpleMock.mockImplementation(async (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        generationConfig: {
          thinkingConfig: { thinkingBudget: -1 },
        },
      };
      options?.onPayload?.(payload, _model);
      return { content: [{ type: "text", text: "ok" }], payload };
    });
  });

  it("returns the original model untouched for non-Google APIs", () => {
    const model = { ...makeModel("anything"), api: "openai-responses" } as unknown as Model<"openai-responses">;
    const result = prepareGoogleSimpleCompletionModel(model);
    expect(result).toBe(model as unknown);
    expect(ensureCustomApiRegisteredMock).not.toHaveBeenCalled();
  });

  it("registers an OpenClaw-owned api alias for google-generative-ai", () => {
    const model = makeModel("gemini-flash-latest");
    const result = prepareGoogleSimpleCompletionModel(model);
    expect(result.api).toBe(GOOGLE_SIMPLE_COMPLETION_API);
    expect(ensureCustomApiRegisteredMock).toHaveBeenCalledTimes(1);
    expect(ensureCustomApiRegisteredMock.mock.calls[0][0]).toBe(GOOGLE_SIMPLE_COMPLETION_API);
  });

  for (const reasoning of ["off", "low", "medium", "high"] as const) {
    it(`sanitizes outbound thinking payload for gemini-flash-latest + reasoning=${reasoning}`, async () => {
      const model = makeModel("gemini-flash-latest");
      const wrapped = prepareGoogleSimpleCompletionModel(model);
      const streamFn = ensureCustomApiRegisteredMock.mock.calls[0][1] as (
        ...args: unknown[]
      ) => Promise<unknown>;
      const ctx = { messages: [] } as unknown;
      await streamFn(wrapped, ctx, { reasoning, apiKey: "key" });

      // streamSimple should have been invoked with the model rewritten back to
      // the canonical google-generative-ai api (pi-ai needs the original key).
      expect(streamSimpleMock).toHaveBeenCalledTimes(1);
      const [streamedModel] = streamSimpleMock.mock.calls[0];
      expect((streamedModel as Model<"google-generative-ai">).api).toBe("google-generative-ai");

      expect(sanitizeGoogleThinkingPayloadMock).toHaveBeenCalledTimes(1);
      const sanitizeArgs = sanitizeGoogleThinkingPayloadMock.mock.calls[0][0] as {
        modelId: string;
        thinkingLevel: string | undefined;
      };
      expect(sanitizeArgs.modelId).toBe("gemini-flash-latest");
      expect(sanitizeArgs.thinkingLevel).toBe(reasoning);

      sanitizeGoogleThinkingPayloadMock.mockClear();
      streamSimpleMock.mockClear();
    });
  }

  it("uses end-to-end real sanitizer to strip thinkingBudget=-1 for gemini-flash-latest (off)", async () => {
    sanitizeGoogleThinkingPayloadMock.mockImplementationOnce((args: { payload: Record<string, unknown> }) => {
      // Mimic real sanitizer: for gemini-flash-latest off => MINIMAL
      const gc = args.payload.generationConfig as Record<string, unknown>;
      const tc = gc.thinkingConfig as Record<string, unknown>;
      delete tc.thinkingBudget;
      tc.thinkingLevel = "MINIMAL";
    });

    const model = makeModel("gemini-flash-latest");
    const wrapped = prepareGoogleSimpleCompletionModel(model);
    const streamFn = ensureCustomApiRegisteredMock.mock.calls[0][1] as (
      ...args: unknown[]
    ) => Promise<unknown>;

    let captured: unknown;
    streamSimpleMock.mockImplementationOnce(async (_m, _c, options) => {
      const payload: Record<string, unknown> = {
        generationConfig: { thinkingConfig: { thinkingBudget: -1 } },
      };
      options?.onPayload?.(payload, _m);
      captured = payload;
      return { content: [] };
    });

    await streamFn(wrapped, { messages: [] }, { reasoning: "off", apiKey: "key" });

    const payload = captured as { generationConfig: { thinkingConfig: Record<string, unknown> } };
    expect(payload.generationConfig.thinkingConfig).not.toHaveProperty("thinkingBudget");
    expect(payload.generationConfig.thinkingConfig).toHaveProperty("thinkingLevel", "MINIMAL");
  });
});
