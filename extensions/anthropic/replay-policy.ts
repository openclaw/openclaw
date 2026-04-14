import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";

const { buildReplayPolicy } = buildProviderReplayFamilyHooks({
  family: "native-anthropic-by-model",
});

if (!buildReplayPolicy) {
  throw new Error("Expected native Anthropic replay hooks to expose buildReplayPolicy.");
}

export { buildReplayPolicy as buildAnthropicReplayPolicy };
