import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../../types.js";

export const BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE = "openclaw.background-result-placement";

export type BackgroundResultPlacement = {
  afterEntryId: string | null;
  resultEntryIds: string[];
};

/** Pending artifacts remain displayable, but only their placement enters model context. */
export function isPendingBackgroundResultMessage(message: unknown): message is Extract<
  AgentMessage,
  { role: "assistant" }
> & {
  excludeFromContext: true;
  openclawModelPlacement: "pending";
} {
  const value = asOptionalRecord(message);
  return (
    value?.role === "assistant" &&
    value.provider === "openclaw" &&
    value.model === "automation-result" &&
    value.excludeFromContext === true &&
    value.openclawModelPlacement === "pending"
  );
}

export function readBackgroundResultPlacement(
  entry: unknown,
): BackgroundResultPlacement | undefined {
  const value = asOptionalRecord(entry);
  if (value?.type !== "custom" || value.customType !== BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE) {
    return undefined;
  }
  const data = asOptionalRecord(value.data);
  if (
    !data ||
    (data.afterEntryId !== null && typeof data.afterEntryId !== "string") ||
    !Array.isArray(data.resultEntryIds) ||
    data.resultEntryIds.length === 0 ||
    !data.resultEntryIds.every((id): id is string => typeof id === "string" && id.length > 0)
  ) {
    throw new Error("Invalid background result placement marker");
  }
  return { afterEntryId: data.afterEntryId, resultEntryIds: data.resultEntryIds };
}

/** The transient replay copy never changes the accepted artifact or its media ownership. */
export function projectPlacedBackgroundResultMessage(message: AgentMessage): AgentMessage {
  if (!isPendingBackgroundResultMessage(message)) {
    throw new Error("Background result placement references an unavailable pending artifact");
  }
  const {
    excludeFromContext: _excluded,
    openclawModelPlacement: _placement,
    ...projected
  } = message;
  return projected;
}
