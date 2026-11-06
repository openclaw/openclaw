import type { OpenClawConfig } from "../config/types.openclaw.js";
import { gateAgentToolExecution } from "./agent-tool-availability.js";
import { resolveSessionCapabilityEntry } from "./subagents/spawn/subagent-capabilities.js";
import type {
  PreparedSessionCapabilityEntry,
  SessionCapabilityStore,
} from "./subagents/spawn/subagent-session-store.js";
import type { AnyAgentTool } from "./tools/common.js";

/** Read the same session-owned fact for coding and standalone tool assembly. */
export function resolveSessionToolListingClientCaps(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  runSessionKey?: string;
  agentSessionKey?: string;
  clientCaps?: string[];
  preparedSessionEntry?: PreparedSessionCapabilityEntry;
  preparedSessionCapabilityStore?: SessionCapabilityStore;
}): string[] {
  const sessionKey = params.runSessionKey ?? params.sessionKey ?? params.agentSessionKey;
  const entry = sessionKey
    ? params.preparedSessionEntry?.sessionKey === sessionKey
      ? params.preparedSessionEntry.entry
      : resolveSessionCapabilityEntry({
          sessionKey,
          cfg: params.config,
          store: params.preparedSessionCapabilityStore,
        })
    : undefined;
  return entry?.clientCapabilities ?? params.clientCaps ?? [];
}

/**
 * List tools from the session's recorded operator capabilities, so internal
 * wakes retain the same catalog. Current-turn capabilities gate execution;
 * attached-client tools also check their live recipient at the point of effect.
 */
export function filterToolsByClientCaps(
  tools: AnyAgentTool[],
  listingClientCaps: string[] | undefined,
  executionClientCaps: string[] | undefined,
): AnyAgentTool[] {
  const listed = new Set(listingClientCaps ?? []);
  const current = new Set(executionClientCaps ?? []);
  return tools
    .filter((tool) => !tool.requiredClientCaps?.some((cap) => !listed.has(cap)))
    .map((tool) =>
      tool.requiredClientCaps?.some((cap) => !current.has(cap))
        ? gateAgentToolExecution(
            tool,
            `${tool.name} requires a connected requesting client with ${tool.requiredClientCaps.join(", ")}; ask again from the open Control UI.`,
          )
        : tool,
    );
}
