import { completeSimple, type Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "../../src/agents/live-test-helpers.js";
import { buildDeepSeekProvider } from "./provider-catalog.js";

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const DEEPSEEK_LIVE_MODEL = process.env.OPENCLAW_LIVE_DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";
const LIVE = isLiveTestEnabled(["DEEPSEEK_LIVE_TEST"]);

const describeLive = LIVE && DEEPSEEK_KEY ? describe : describe.skip;

function forceDeepSeekNonThinkingPath(payload: unknown): void {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const request = payload as Record<string, unknown>;
  request.thinking = { type: "disabled" };
  delete request.reasoning_effort;
}

function resolveDeepSeekLiveModel(): Model<"openai-completions"> {
  const provider = buildDeepSeekProvider();
  const model = provider.models?.find((entry) => entry.id === DEEPSEEK_LIVE_MODEL);
  if (!model) {
    throw new Error(`DeepSeek bundled catalog does not include ${DEEPSEEK_LIVE_MODEL}`);
  }
  return {
    provider: "deepseek",
    baseUrl: provider.baseUrl,
    ...model,
    api: "openai-completions",
  } as Model<"openai-completions">;
}

describeLive("deepseek plugin live", () => {
  it("returns assistant text from the bundled V4 model catalog", async () => {
    const res = await completeSimple(
      resolveDeepSeekLiveModel(),
      {
        messages: createSingleUserPromptMessage(),
      },
      {
        apiKey: DEEPSEEK_KEY,
        maxTokens: 64,
        onPayload: forceDeepSeekNonThinkingPath,
      },
    );

    if (res.stopReason === "error") {
      throw new Error(res.errorMessage || "DeepSeek returned error with no message");
    }

    const text = extractNonEmptyAssistantText(res.content);
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);
});
