/**
 * Runtime channel capability collector.
 *
 * Agent startup uses this to merge configured channel capabilities with prompt
 * tools.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntriesLower } from "@openclaw/normalization-core/string-normalization";
import { resolveChannelCapabilities } from "../config/channel-capabilities.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { resolveChannelPromptCapabilities } from "./channel-tools.js";

function mergeRuntimeCapabilities(
  base?: readonly string[] | null,
  additions: readonly string[] = [],
): string[] | undefined {
  const merged = [...(base ?? [])];
  const seen = new Set(normalizeStringEntriesLower(merged));

  for (const capability of additions) {
    const normalizedCapability = normalizeOptionalLowercaseString(capability);
    if (!normalizedCapability || seen.has(normalizedCapability)) {
      continue;
    }
    seen.add(normalizedCapability);
    merged.push(capability);
  }

  return merged.length > 0 ? merged : undefined;
}

/** Collects the effective runtime capabilities for a channel/account pair. */
export function collectRuntimeChannelCapabilities(params: {
  cfg?: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): string[] | undefined {
  if (!params.channel) {
    return undefined;
  }
  // Control UI renders disclosures natively in its markdown pipeline.
  // This capability is core-owned because webchat has no channel plugin.
  const internalChannelCapabilities =
    params.channel === INTERNAL_MESSAGE_CHANNEL ? ["markdownDetails"] : [];
  const channelPromptCapabilities = params.cfg ? resolveChannelPromptCapabilities(params) : [];
  return mergeRuntimeCapabilities(resolveChannelCapabilities(params), [
    ...channelPromptCapabilities,
    ...internalChannelCapabilities,
  ]);
}
