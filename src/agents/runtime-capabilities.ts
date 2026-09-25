/**
 * Runtime channel capability collector.
 *
 * Agent startup uses this to merge configured channel capabilities with prompt
 * tools and thread-bound spawn features that depend on channel policy.
 */
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
  normalizeGatewayClientId,
} from "@openclaw/gateway-protocol/client-info";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntriesLower } from "@openclaw/normalization-core/string-normalization";
import { supportsThreadBindingSpawn } from "../channels/conversation-resolution.js";
import { resolveThreadBindingSpawnPolicy } from "../channels/thread-bindings-policy.js";
import { resolveChannelCapabilities } from "../config/channel-capabilities.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveChannelPromptCapabilities } from "./channel-tools.js";

const NATIVE_DISCLOSURE_CLIENT_IDS = new Set<string>([
  GATEWAY_CLIENT_IDS.MACOS_APP,
  GATEWAY_CLIENT_IDS.IOS_APP,
  GATEWAY_CLIENT_IDS.ANDROID_APP,
]);

const THREAD_BOUND_SUBAGENT_SPAWN_CAPABILITY = "threadbound-subagent-spawn";
const THREAD_BOUND_ACP_SPAWN_CAPABILITY = "threadbound-acp-spawn";

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

/** Capability fields from the gateway client that originated a run. */
export function originClientFields(source: {
  clientCaps?: string[] | null;
  clientId?: string | null;
}): { clientCaps?: string[] | null; clientId?: string } {
  return source.clientId
    ? { clientCaps: source.clientCaps, clientId: source.clientId }
    : { clientCaps: source.clientCaps };
}

/** Collects the effective runtime capabilities for a channel/account pair. */
export function collectRuntimeChannelCapabilities(params: {
  cfg?: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  clientCaps?: string[] | null;
  clientId?: string | null;
}): string[] | undefined {
  if (!params.channel) {
    return undefined;
  }
  // The handshake flag is authoritative for browser clients. Installed macOS,
  // iOS, and Android apps render disclosures but predate that flag, so their
  // client id still grants it. An explicit list without the flag does not.
  const clientId = normalizeGatewayClientId(params.clientId);
  const internalChannelCapabilities =
    hasGatewayClientCap(params.clientCaps, GATEWAY_CLIENT_CAPS.MARKDOWN_DETAILS) ||
    (clientId != null && NATIVE_DISCLOSURE_CLIENT_IDS.has(clientId))
      ? ["markdownDetails"]
      : [];
  const threadSpawnCapabilities: string[] = [];
  if (params.cfg && supportsThreadBindingSpawn(params.channel)) {
    for (const [kind, capability] of [
      ["subagent", THREAD_BOUND_SUBAGENT_SPAWN_CAPABILITY],
      ["acp", THREAD_BOUND_ACP_SPAWN_CAPABILITY],
    ] as const) {
      const policy = resolveThreadBindingSpawnPolicy({
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId ?? undefined,
        kind,
      });
      if (policy.enabled && policy.spawnEnabled) {
        // Thread-bound spawn is only advertised when both policy gates are enabled.
        threadSpawnCapabilities.push(capability);
      }
    }
  }
  const channelPromptCapabilities = params.cfg ? resolveChannelPromptCapabilities(params) : [];
  return mergeRuntimeCapabilities(resolveChannelCapabilities(params), [
    ...channelPromptCapabilities,
    ...internalChannelCapabilities,
    ...threadSpawnCapabilities,
  ]);
}
