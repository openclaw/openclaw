import type { SessionModelState } from "@agentclientprotocol/sdk";
import type { SessionAcpxState, SessionRecord } from "./runtime-types.js";

function ensureAcpxState(state: SessionAcpxState | undefined): SessionAcpxState {
  return state ?? {};
}

export function normalizeModeId(modeId: string | undefined): string | undefined {
  if (typeof modeId !== "string") {
    return undefined;
  }
  const trimmed = modeId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeModelId(modelId: string | undefined): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const trimmed = modelId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getDesiredModeId(state: SessionAcpxState | undefined): string | undefined {
  return normalizeModeId(state?.desired_mode_id);
}

export function setDesiredModeId(record: SessionRecord, modeId: string | undefined): void {
  const acpx = ensureAcpxState(record.acpx);
  const normalized = normalizeModeId(modeId);

  if (normalized) {
    acpx.desired_mode_id = normalized;
  } else {
    delete acpx.desired_mode_id;
  }

  record.acpx = acpx;
}

export function getDesiredModelId(state: SessionAcpxState | undefined): string | undefined {
  return normalizeModelId(state?.session_options?.model);
}

export function setDesiredModelId(record: SessionRecord, modelId: string | undefined): void {
  const acpx = ensureAcpxState(record.acpx);
  const normalized = normalizeModelId(modelId);
  const sessionOptions = { ...acpx.session_options };

  if (normalized) {
    sessionOptions.model = normalized;
  } else {
    delete sessionOptions.model;
  }

  if (
    typeof sessionOptions.model === "string" ||
    Array.isArray(sessionOptions.allowed_tools) ||
    typeof sessionOptions.max_turns === "number"
  ) {
    acpx.session_options = sessionOptions;
  } else {
    delete acpx.session_options;
  }

  record.acpx = acpx;
}

export function setCurrentModelId(record: SessionRecord, modelId: string | undefined): void {
  const acpx = ensureAcpxState(record.acpx);
  const normalized = normalizeModelId(modelId);

  if (normalized) {
    acpx.current_model_id = normalized;
  } else {
    delete acpx.current_model_id;
  }

  record.acpx = acpx;
}

export function syncAdvertisedModelState(
  record: SessionRecord,
  models: SessionModelState | undefined,
): void {
  if (!models) {
    return;
  }

  const acpx = ensureAcpxState(record.acpx);
  acpx.current_model_id = models.currentModelId;
  acpx.available_models = models.availableModels.map((model) => model.modelId);
  record.acpx = acpx;
}
