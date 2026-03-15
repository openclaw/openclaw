import type { Model } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
} from "./live-test-helpers.js";
import { resolveBedrockBearerToken } from "./model-auth.js";
import { createBedrockBearerTokenWrapper } from "./pi-embedded-runner/anthropic-stream-wrappers.js";

const BEARER_TOKEN = resolveBedrockBearerToken() ?? "";
const LIVE = isTruthyEnvValue(process.env.BEDROCK_LIVE_TEST) || isTruthyEnvValue(process.env.LIVE);
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const MODEL_ID =
  process.env.BEDROCK_LIVE_MODEL?.trim() || "us.anthropic.claude-3-5-haiku-20241022-v1:0";

const describeLive = LIVE && BEARER_TOKEN ? describe : describe.skip;

describeLive("bedrock bearer token auth (live)", () => {
  it("sends a request using Authorization: Bearer and receives a response", async () => {
    const model: Model<"bedrock-converse-stream"> = {
      id: MODEL_ID,
      name: `Bedrock ${MODEL_ID}`,
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      baseUrl: `https://bedrock-runtime.${REGION}.amazonaws.com`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 4096,
    };

    // Apply the bearer token wrapper — this is the code path under test.
    const wrappedStreamFn = createBedrockBearerTokenWrapper(streamSimple, BEARER_TOKEN);

    // StreamFn may return a Promise; await to handle both sync and async.
    const stream = await wrappedStreamFn(
      model,
      { messages: createSingleUserPromptMessage() },
      { maxTokens: 64 },
    );

    let sawDone = false;
    let assistantText = "";
    for await (const event of stream) {
      if (event.type === "text_delta") {
        assistantText += event.delta;
      }
      if (event.type === "done") {
        sawDone = true;
        // Also extract from the final message in case deltas were empty.
        const doneText = extractNonEmptyAssistantText(event.message.content);
        if (doneText && !assistantText.trim()) {
          assistantText = doneText;
        }
      }
    }

    expect(sawDone).toBe(true);
    expect(assistantText.trim().length).toBeGreaterThan(0);
  }, 30_000);
});
