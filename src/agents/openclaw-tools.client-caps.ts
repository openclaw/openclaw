import type { OpenClawConfig } from "../config/types.openclaw.js";
import { gateAgentToolExecution } from "./agent-tool-availability.js";
import { resolveSessionCapabilityEntry } from "./subagents/spawn/subagent-capabilities.js";
import { withLegacySessionCapabilityRead } from "./subagents/spawn/subagent-session-store-legacy.js";
import type {
  PreparedSessionCapabilityEntry,
  SessionCapabilityEntry,
  SessionCapabilityStore,
} from "./subagents/spawn/subagent-session-store.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createTaskSuggestionTools } from "./tools/task-suggestion-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

type TaskSuggestionDeliveryMode = SessionCapabilityEntry["taskSuggestionDeliveryMode"];
type SessionToolListingParams = {
  config?: OpenClawConfig;
  sessionKey?: string;
  runSessionKey?: string;
  agentSessionKey?: string;
  clientCaps?: string[];
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  preparedSessionEntry?: PreparedSessionCapabilityEntry;
  preparedSessionCapabilityStore?: SessionCapabilityStore;
};

function resolveSessionToolListingEntry(params: SessionToolListingParams) {
  const sessionKey = params.runSessionKey ?? params.sessionKey ?? params.agentSessionKey;
  return sessionKey
    ? params.preparedSessionEntry?.sessionKey === sessionKey
      ? params.preparedSessionEntry.entry
      : resolveSessionCapabilityEntry({
          sessionKey,
          cfg: params.config,
          store: params.preparedSessionCapabilityStore,
        })
    : undefined;
}

/** Read the same session-owned fact for coding and standalone tool assembly. */
export function resolveSessionToolListingClientCaps(params: SessionToolListingParams): string[] {
  return resolveSessionToolListingEntry(params)?.clientCapabilities ?? params.clientCaps ?? [];
}

/** Internal turns list task suggestions from the session's latest operator surface. */
export function resolveSessionToolListingTaskSuggestionDeliveryMode(
  params: SessionToolListingParams,
): TaskSuggestionDeliveryMode {
  return (
    params.taskSuggestionDeliveryMode ??
    resolveSessionToolListingEntry(params)?.taskSuggestionDeliveryMode
  );
}

/** Only a turn from a client that can present the card may create or dismiss one. */
function gateTaskSuggestionToolsToCurrentTurn(
  tools: AnyAgentTool[],
  currentMode: TaskSuggestionDeliveryMode,
): AnyAgentTool[] {
  return currentMode === "gateway"
    ? tools
    : tools.map((tool) =>
        gateAgentToolExecution(
          tool,
          `${tool.name} needs a turn from the open Control UI; this turn cannot present task suggestions.`,
        ),
      );
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

/** Captures the session-owned listing facts once, before synchronous tool assembly. */
export function captureSessionToolListing(
  captured: SessionToolListingParams & {
    listingClientCaps?: string[];
    listingTaskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  },
): void {
  captured.listingClientCaps ??= withLegacySessionCapabilityRead(() =>
    resolveSessionToolListingClientCaps(captured),
  );
  captured.listingTaskSuggestionDeliveryMode ??= withLegacySessionCapabilityRead(() =>
    resolveSessionToolListingTaskSuggestionDeliveryMode(captured),
  );
}

/** Lists task suggestions from the session's operator surface; calls still need the live turn's mode. */
export function createListedTaskSuggestionTools(
  options:
    | {
        listingTaskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
        taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
        cwd?: string;
        workspaceDir?: string;
      }
    | undefined,
  sessionKey: string,
  agentId: string | undefined,
  inferredWorkspaceDir: string | undefined,
): AnyAgentTool[] {
  if (options?.listingTaskSuggestionDeliveryMode !== "gateway") {
    return [];
  }
  const cwd = resolveWorkspaceRoot(options.cwd ?? options.workspaceDir ?? inferredWorkspaceDir);
  return gateTaskSuggestionToolsToCurrentTurn(
    createTaskSuggestionTools({ sessionKey, agentId, cwd }),
    options.taskSuggestionDeliveryMode,
  );
}
