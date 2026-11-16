import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AnyAgentTool } from "../agent-tools.types.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import type { describeSessionToolDefinition } from "./session-tool-definition.js";

export type ToolDefinition = ReturnType<typeof describeSessionToolDefinition>;
export type PublicationListing = ToolDefinition &
  Pick<AnyAgentTool, "label" | "async" | "catalogMode"> & { scope?: string };

export type ToolSurface = {
  routeKey: string;
  historyId: string | null;
  /** Digest of the tool policy config; a policy change starts a new pin. */
  toolPolicy: string;
  tools: ToolDefinition[];
  publicationListing?: PublicationListing;
};

/** The latest checkpointed pin, unless a later model change retired it. */
export function readToolSurfaceCheckpoint(entries: SessionEntry[]) {
  const markerIndex = entries.findLastIndex(
    (entry) => entry.type === "custom" && entry.customType === "openclaw.system-prompt",
  );
  const entry = entries[markerIndex];
  const data = entry?.type === "custom" ? entry.data : undefined;
  return isRecord(data) &&
    Array.isArray(data.tools) &&
    !entries.slice(markerIndex + 1).some((later) => later.type === "model_change")
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
