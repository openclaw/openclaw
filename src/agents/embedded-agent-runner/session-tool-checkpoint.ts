import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AnyAgentTool } from "../agent-tools.types.js";
import { readGitHubPublicationToolSelection } from "../github-tool-identity-config.js";
import {
  participationToolConstraints,
  type ParticipationCeiling,
} from "../participation-ceiling.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import type { describeSessionToolDefinition } from "./session-tool-definition.js";

export type ToolDefinition = ReturnType<typeof describeSessionToolDefinition>;
type PublicationListing = ToolDefinition &
  Pick<AnyAgentTool, "label" | "async" | "catalogMode"> & { scope?: string };

export type ToolSurface = {
  routeKey: string;
  historyId: string | null;
  /** Digest of tool policy and participation scope; a change starts a new pin. */
  toolPolicy: string;
  /** Absent until the series' first request pins its tools; a listing can precede it. */
  tools?: ToolDefinition[];
  publicationListing?: PublicationListing;
};

/** The latest checkpointed pin, unless a later model change retired it. */
export function readToolSurfaceCheckpoint(entries: SessionEntry[]) {
  const entry = selectToolSurfaceCheckpoint(
    entries,
    (candidate) => candidate.type === "custom" && candidate.customType === "openclaw.system-prompt",
  );
  const data = entry?.type === "custom" ? entry.data : undefined;
  return isRecord(data) && Array.isArray(data.tools)
    ? {
        routeKey: data.routeKey,
        historyId: data.historyId,
        toolPolicy: data.toolPolicy,
        // SAFETY: the session prompt owner alone writes the tool definitions and publication listing checkpoint.
        tools: data.tools as ToolDefinition[],
        // SAFETY: the session prompt owner alone checkpoints PublicationListing values; older pins omit the field.
        publicationListing: data.publicationListing as PublicationListing | undefined,
      }
    : undefined;
}

/** Array and scalar readers retire a pin on every newer checkpoint or model change. */
export function selectToolSurfaceCheckpoint<T extends { type: string }>(
  entries: readonly T[],
  isCheckpoint: (entry: T) => boolean,
): T | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === "model_change") {
      return undefined;
    }
    if (isCheckpoint(entry)) {
      return entry;
    }
  }
  return undefined;
}

/** Configuration and admitted participation scope a pin depends on. */
export function resolveSessionToolPolicyDigest(
  config: OpenClawConfig | undefined,
  agentId: string,
  participationCeiling?: ParticipationCeiling,
) {
  return sha256Hex(
    stableStringify([
      config?.tools,
      config?.agents?.entries?.[agentId]?.tools,
      config?.plugins,
      config?.mcp,
      config?.desktop,
      readGitHubPublicationToolSelection(config ?? {}),
      // Hard participation ceilings must not revive the creator's pinned tools or
      // leave the next creator turn pinned to a participant's narrower inventory.
      ...(participationCeiling
        ? [
            {
              participation: participationToolConstraints(participationCeiling).map((allow) =>
                [...new Set(allow)].toSorted(),
              ),
            },
          ]
        : []),
    ]),
  );
}
