import {
  createDefaultWorkboardSessionsBoardSpec,
  type WorkboardBoardMetadata,
  type WorkboardOrchestrationSettings,
} from "@openclaw/workboard-contract";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WorkboardBoardInput } from "./store-inputs.js";
import {
  normalizeBoardId,
  normalizeBoundedString,
  normalizeWorkspace,
} from "./store-normalizers.js";

export function normalizeBoardMetadata(
  input: WorkboardBoardInput,
  fallback: WorkboardBoardMetadata | undefined,
  now = Date.now(),
): WorkboardBoardMetadata {
  const id = normalizeBoardId(input.id, fallback?.id) ?? "default";
  if (input.kind !== undefined && input.kind !== "cards" && input.kind !== "sessions") {
    throw new Error("board kind must be cards or sessions.");
  }
  if (fallback && input.kind !== undefined && input.kind !== (fallback.kind ?? "cards")) {
    throw new Error("board kind cannot be changed after creation.");
  }
  const kind = input.kind === "sessions" ? "sessions" : fallback?.kind;
  if (kind === "sessions" && id === "default") {
    throw new Error("board kind cannot be changed after creation: default is a cards board.");
  }
  const name = normalizeBoundedString(input.name, fallback?.name, 120, "board name");
  const description = normalizeBoundedString(
    input.description,
    fallback?.description,
    1000,
    "board description",
  );
  const clearAppearance = input.clearAppearance === undefined ? [] : input.clearAppearance;
  if (
    !Array.isArray(clearAppearance) ||
    clearAppearance.some((field) => field !== "icon" && field !== "color")
  ) {
    throw new Error("clearAppearance must be an array containing only icon or color.");
  }
  // Legacy empty/null inputs preserve appearance. Explicit clears take precedence.
  const icon = clearAppearance.includes("icon")
    ? undefined
    : normalizeBoundedString(input.icon, fallback?.icon, 40, "board icon");
  const color = clearAppearance.includes("color")
    ? undefined
    : normalizeBoundedString(input.color, fallback?.color, 40, "board color");
  let automationJobId = fallback?.automationJobId;
  if (Object.hasOwn(input, "automationJobId")) {
    automationJobId = normalizeOptionalString(input.automationJobId);
    if (!automationJobId) {
      throw new Error("automation job id must be a non-empty string.");
    }
    if (automationJobId.length > 128) {
      throw new Error("automation job id must be 128 characters or fewer.");
    }
  }
  const defaultWorkspace = Object.hasOwn(input, "defaultWorkspace")
    ? normalizeWorkspace(input.defaultWorkspace, fallback?.defaultWorkspace)
    : fallback?.defaultWorkspace;
  const orchestration = Object.hasOwn(input, "orchestration")
    ? normalizeOrchestration(input.orchestration, fallback?.orchestration)
    : fallback?.orchestration;
  const archivedAt = Object.hasOwn(input, "archived")
    ? input.archived === false
      ? undefined
      : now
    : fallback?.archivedAt;
  return {
    id,
    ...(kind ? { kind } : {}),
    ...(kind === "sessions"
      ? { sessions: fallback?.sessions ?? createDefaultWorkboardSessionsBoardSpec() }
      : {}),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    ...(color ? { color } : {}),
    ...(automationJobId ? { automationJobId } : {}),
    ...(defaultWorkspace ? { defaultWorkspace } : {}),
    ...(orchestration ? { orchestration } : {}),
    createdAt: fallback?.createdAt ?? now,
    updatedAt: now,
    ...(archivedAt ? { archivedAt } : {}),
  };
}

function normalizeOrchestration(
  value: unknown,
  fallback?: WorkboardOrchestrationSettings,
): WorkboardOrchestrationSettings | undefined {
  if (!isRecord(value)) {
    return fallback;
  }
  const record = value;
  const autoDecompose =
    typeof record.autoDecompose === "boolean" ? record.autoDecompose : fallback?.autoDecompose;
  const autoDecomposePerDispatch =
    resolveOptionalIntegerOption(record.autoDecomposePerDispatch, { min: 1, max: 20 }) ??
    fallback?.autoDecomposePerDispatch;
  const defaultAssignee = normalizeBoundedString(
    record.defaultAssignee,
    fallback?.defaultAssignee,
    120,
    "default assignee",
  );
  const orchestratorProfile = normalizeBoundedString(
    record.orchestratorProfile,
    fallback?.orchestratorProfile,
    120,
    "orchestrator profile",
  );
  const next: WorkboardOrchestrationSettings = {
    ...(autoDecompose !== undefined ? { autoDecompose } : {}),
    ...(autoDecomposePerDispatch ? { autoDecomposePerDispatch } : {}),
    ...(defaultAssignee ? { defaultAssignee } : {}),
    ...(orchestratorProfile ? { orchestratorProfile } : {}),
  };
  return Object.keys(next).length ? next : undefined;
}
