import type { Model } from "@mariozechner/pi-ai";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { applyExtraParamsToAgent } from "./pi-embedded-runner.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";
const LIVE = isTruthyEnvValue(process.env.OPENAI_LIVE_TEST) || isTruthyEnvValue(process.env.LIVE);
const GEMINI_LIVE =
  isTruthyEnvValue(process.env.GEMINI_LIVE_TEST) || isTruthyEnvValue(process.env.LIVE);

const describeLive = LIVE && OPENAI_KEY ? describe : describe.skip;
const describeGeminiLive = GEMINI_LIVE && GEMINI_KEY ? describe : describe.skip;

describeLive("pi embedded extra params (live)", () => {
  it("applies config maxTokens to openai streamFn", async () => {
    const model = getModel("openai", "gpt-5.2") as unknown as Model<"openai-completions">;

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.2": {
              // OpenAI Responses enforces a minimum max_output_tokens of 16.
              params: {
                maxTokens: 16,
              },
            },
          },
        },
      },
    };

    const agent = { streamFn: streamSimple };

    applyExtraParamsToAgent(agent, cfg, "openai", model.id);

    const stream = agent.streamFn(
      model,
      {
        messages: [
          {
            role: "user",
            content: "Write the alphabet letters A through Z as words separated by commas.",
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: OPENAI_KEY },
    );

    let stopReason: string | undefined;
    let outputTokens: number | undefined;
    for await (const event of stream) {
      if (event.type === "done") {
        stopReason = event.reason;
        outputTokens = event.message.usage.output;
      }
    }

    expect(stopReason).toBeDefined();
    expect(outputTokens).toBeDefined();
    // Should respect maxTokens from config (16) — allow a small buffer for provider rounding.
    expect(outputTokens ?? 0).toBeLessThanOrEqual(20);
  }, 30_000);
});

describeGeminiLive("pi embedded extra params (gemini live)", () => {
  function isGoogleModelUnavailableError(raw: string | undefined): boolean {
    const msg = (raw ?? "").toLowerCase();
    if (!msg) {
      return false;
    }
    return (
      msg.includes("not found") ||
      msg.includes("404") ||
      msg.includes("not_available") ||
      msg.includes("permission denied") ||
      msg.includes("unsupported model")
    );
  }

  function isGoogleImageProcessingError(raw: string | undefined): boolean {
    const msg = (raw ?? "").toLowerCase();
    if (!msg) {
      return false;
    }
    return (
      msg.includes("unable to process input image") ||
      msg.includes("invalid_argument") ||
      msg.includes("bad request")
    );
  }

  async function runGeminiProbe(params: {
    agentStreamFn: typeof streamSimple;
    model: Model<"google-generative-ai">;
    apiKey: string;
    oneByOneRedPngBase64: string;
    includeImage?: boolean;
    prompt: string;
    onPayload?: (payload: Record<string, unknown>) => void;
  }): Promise<{ sawDone: boolean; stopReason?: string; errorMessage?: string }> {
    const userContent: Array<
      { type: "text"; text: string } | { type: "image"; mimeType: string; data: string }
    > = [{ type: "text", text: params.prompt }];
    if (params.includeImage ?? true) {
      userContent.push({
        type: "image",
        mimeType: "image/png",
        data: params.oneByOneRedPngBase64,
      });
    }

    const stream = params.agentStreamFn(
      params.model,
      {
        messages: [
          {
            role: "user",
            content: userContent,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: params.apiKey,
        reasoning: "high",
        maxTokens: 64,
        onPayload: (payload) => {
          params.onPayload?.(payload as Record<string, unknown>);
        },
      },
    );

    let sawDone = false;
    let stopReason: string | undefined;
    let errorMessage: string | undefined;

    for await (const event of stream) {
      if (event.type === "done") {
        sawDone = true;
        stopReason = event.reason;
      } else if (event.type === "error") {
        stopReason = event.reason;
        errorMessage = event.error?.errorMessage;
      }
    }

    return { sawDone, stopReason, errorMessage };
  }

  it("sanitizes Gemini 3.1 thinking payload and keeps image parts with reasoning enabled", async () => {
    const model = getModel("google", "gemini-2.5-pro") as unknown as Model<"google-generative-ai">;

    const agent = { streamFn: streamSimple };
    applyExtraParamsToAgent(agent, undefined, "google", model.id, undefined, "high");

    const oneByOneRedPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4zwAAAgIBAJBzWgkAAAAASUVORK5CYII=";

    let capturedPayload: Record<string, unknown> | undefined;
    const imageResult = await runGeminiProbe({
      agentStreamFn: agent.streamFn,
      model,
      apiKey: GEMINI_KEY,
      oneByOneRedPngBase64,
      includeImage: true,
      prompt: "What color is this image? Reply with one word.",
      onPayload: (payload) => {
        capturedPayload = payload;
      },
    });

    expect(capturedPayload).toBeDefined();
    const thinkingConfig = (
      capturedPayload?.config as { thinkingConfig?: Record<string, unknown> } | undefined
    )?.thinkingConfig;
    expect(thinkingConfig?.thinkingBudget).toBeUndefined();
    expect(thinkingConfig?.thinkingLevel).toBe("HIGH");

    const imagePart = (
      capturedPayload?.contents as
        | Array<{ parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> }>
        | undefined
    )?.[0]?.parts?.find((part) => part.inlineData !== undefined)?.inlineData;
    expect(imagePart).toEqual({
      mimeType: "image/png",
      data: oneByOneRedPngBase64,
    });

    if (!imageResult.sawDone && !isGoogleModelUnavailableError(imageResult.errorMessage)) {
      expect(isGoogleImageProcessingError(imageResult.errorMessage)).toBe(true);
    }

    const textResult = await runGeminiProbe({
      agentStreamFn: agent.streamFn,
      model,
      apiKey: GEMINI_KEY,
      oneByOneRedPngBase64,
      includeImage: false,
      prompt: "Reply with exactly OK.",
    });

    if (!textResult.sawDone && isGoogleModelUnavailableError(textResult.errorMessage)) {
      // Some keys/regions do not expose Gemini 3.1 preview. Fall back to a
      // stable model to keep live reasoning verification active.
      const fallbackModel = getModel(
        "google",
        "gemini-2.5-pro",
      ) as unknown as Model<"google-generative-ai">;
      const fallback = await runGeminiProbe({
        agentStreamFn: agent.streamFn,
        model: fallbackModel,
        apiKey: GEMINI_KEY,
        oneByOneRedPngBase64,
        includeImage: false,
        prompt: "Reply with exactly OK.",
      });
      expect(fallback.sawDone).toBe(true);
      expect(fallback.stopReason).toBeDefined();
      expect(fallback.stopReason).not.toBe("error");
      return;
    }

    expect(textResult.sawDone).toBe(true);
    expect(textResult.stopReason).toBeDefined();
    expect(textResult.stopReason).not.toBe("error");
  }, 45_000);
});
