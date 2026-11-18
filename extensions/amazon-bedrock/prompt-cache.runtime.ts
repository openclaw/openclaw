import type { CachePointBlock, SystemContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { sanitizeSurrogates, type CacheRetention } from "openclaw/plugin-sdk/llm";
import {
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
} from "openclaw/plugin-sdk/provider-transport-runtime";

export function buildBedrockSystemPrompt(
  systemPrompt: string | undefined,
  cacheRetention: CacheRetention,
  cachePoint: CachePointBlock | undefined,
): SystemContentBlock[] | undefined {
  if (!systemPrompt) {
    return undefined;
  }

  const strippedPrompt = stripSystemPromptCacheBoundary(systemPrompt);
  if (cacheRetention === "none") {
    return [{ text: sanitizeSurrogates(strippedPrompt) }];
  }
  const split = splitSystemPromptCacheBoundary(systemPrompt);
  const stablePrefix = split?.dynamicSuffix
    ? stripSystemPromptCacheBoundary(split.stablePrefix)
    : strippedPrompt;
  const dynamicSuffix = split?.dynamicSuffix ? strippedPrompt.slice(stablePrefix.length) : "";
  const blocks: SystemContentBlock[] = stablePrefix
    ? [{ text: sanitizeSurrogates(stablePrefix) }]
    : [];

  if (stablePrefix && cachePoint) {
    blocks.push({ cachePoint });
  }
  if (dynamicSuffix) {
    blocks.push({ text: sanitizeSurrogates(dynamicSuffix) });
  }
  return blocks.length > 0 ? blocks : undefined;
}
