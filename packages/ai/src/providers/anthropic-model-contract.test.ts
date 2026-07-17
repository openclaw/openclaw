import { describe, expect, it } from "vitest";
import { resolveModelBoundThinkingReplayMode } from "./anthropic-model-contract.js";

const SONNET5 = "claude-sonnet-5";

function ref(provider: string, modelId: string = SONNET5) {
  return { provider, api: "anthropic-messages", modelId };
}

describe("resolveModelBoundThinkingReplayMode", () => {
  it("preserves model-bound thinking on the exact same provider route", () => {
    expect(
      resolveModelBoundThinkingReplayMode({
        source: ref("anthropic"),
        target: ref("anthropic"),
      }),
    ).toBe("preserve");
  });

  // Regression: the same-model branch compared only api+identity, so signed
  // thinking issued by one platform was replayed through a different
  // provider serving the same Claude identity. Foreign platforms reject the
  // signature on every turn, permanently bricking the persisted session.
  it.each([
    ["anthropic", "amazon-bedrock-mantle"],
    ["anthropic", "anthropic-vertex"],
    ["anthropic-vertex", "anthropic"],
    ["anthropic", "github-copilot"],
  ])("drops model-bound thinking when switching providers %s -> %s", (source, target) => {
    expect(
      resolveModelBoundThinkingReplayMode({
        source: ref(source),
        target: ref(target),
      }),
    ).toBe("drop");
  });

  it("drops model-bound thinking across different Claude 5 identities", () => {
    expect(
      resolveModelBoundThinkingReplayMode({
        source: ref("anthropic", "claude-sonnet-5"),
        target: ref("anthropic", "claude-fable-5"),
      }),
    ).toBe("drop");
  });

  it("preserves cloud-id variants of one identity on the same provider", () => {
    expect(
      resolveModelBoundThinkingReplayMode({
        source: ref("amazon-bedrock-mantle", "us.anthropic.claude-sonnet-5-20260929-v1:0"),
        target: ref("amazon-bedrock-mantle", "claude-sonnet-5-20260929-v1:0"),
      }),
    ).toBe("preserve");
  });

  it("preserves same-route replay when only the response model proves the identity", () => {
    // Deployment aliases may hide the identity on the persisted side; the
    // same provider+api+modelId route is still the issuing platform.
    expect(
      resolveModelBoundThinkingReplayMode({
        source: { provider: "anthropic", api: "anthropic-messages", modelId: "my-alias" },
        target: {
          provider: "anthropic",
          api: "anthropic-messages",
          modelId: "my-alias",
          responseModelId: SONNET5,
        },
      }),
    ).toBe("preserve");
  });

  it("stays default for non-Claude-5 identities", () => {
    expect(
      resolveModelBoundThinkingReplayMode({
        source: ref("anthropic", "claude-opus-4-8"),
        target: ref("amazon-bedrock-mantle", "claude-opus-4-8"),
      }),
    ).toBe("default");
  });
});
