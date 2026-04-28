import { completeSimple, type Model } from "@mariozechner/pi-ai";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { buildIlmuProvider } from "./provider-catalog.js";

const ILMU_KEY = process.env.ILMU_API_KEY ?? "";
const ILMU_LIVE_MODEL = process.env.OPENCLAW_LIVE_ILMU_MODEL?.trim() || "nemo-super";
const LIVE = isLiveTestEnabled(["ILMU_LIVE_TEST"]);

const describeLive = LIVE && ILMU_KEY ? describe : describe.skip;

function resolveIlmuLiveModel(modelId: string): Model<"openai-completions"> {
  const provider = buildIlmuProvider();
  const model = provider.models?.find((entry) => entry.id === modelId);
  if (!model) {
    throw new Error(`ILMU bundled catalog does not include ${modelId}`);
  }
  return {
    provider: "ilmu",
    baseUrl: provider.baseUrl,
    ...model,
    api: "openai-completions",
  } as Model<"openai-completions">;
}

describeLive("ilmu plugin live", () => {
  it("returns assistant text from the bundled catalog", async () => {
    const res = await completeSimple(
      resolveIlmuLiveModel(ILMU_LIVE_MODEL),
      {
        messages: createSingleUserPromptMessage(),
      },
      {
        apiKey: ILMU_KEY,
        maxTokens: 64,
      },
    );

    if (res.stopReason === "error") {
      throw new Error(res.errorMessage || "ILMU returned error with no message");
    }

    const text = extractNonEmptyAssistantText(res.content);
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);

  it("returns assistant text from the smaller nano model", async () => {
    const res = await completeSimple(
      resolveIlmuLiveModel("ilmu-nemo-nano"),
      {
        messages: createSingleUserPromptMessage(),
      },
      {
        apiKey: ILMU_KEY,
        maxTokens: 64,
      },
    );

    if (res.stopReason === "error") {
      throw new Error(res.errorMessage || "ILMU nano returned error with no message");
    }

    const text = extractNonEmptyAssistantText(res.content);
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);
});
