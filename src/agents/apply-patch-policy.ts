import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import type { ExecToolConfig } from "../config/types.tools.js";
import type { ApplyPatchContainmentSource } from "./apply-patch-containment-hint.js";
import type { resolveSessionPermissionCoreToolPolicy } from "./session-permission-exec-mode.js";

export function resolveConfiguredApplyPatchPolicy(params: {
  config?: ExecToolConfig["applyPatch"];
  workspaceOnly: boolean;
  readOnly: boolean;
  requireWorkspaceOnly: boolean;
  sessionPolicy?: ReturnType<typeof resolveSessionPermissionCoreToolPolicy>;
  modelProvider?: string;
  modelId?: string;
}) {
  const applyPatchWorkspaceOnly =
    params.workspaceOnly ||
    (params.sessionPolicy?.applyPatchWorkspaceOnly ?? params.config?.workspaceOnly !== false);
  const applyPatchContainmentSource: ApplyPatchContainmentSource = params.requireWorkspaceOnly
    ? "required-root"
    : params.sessionPolicy
      ? "session"
      : "config";
  return {
    applyPatchEnabled:
      !params.readOnly &&
      params.config?.enabled !== false &&
      isApplyPatchAllowedForModel({
        modelProvider: params.modelProvider,
        modelId: params.modelId,
        allowModels: params.config?.allowModels,
      }),
    applyPatchWorkspaceOnly,
    applyPatchContainmentSource,
  };
}

export function isApplyPatchAllowedForModel(params: {
  modelProvider?: string;
  modelId?: string;
  allowModels?: string[];
}) {
  const allowModels = Array.isArray(params.allowModels) ? params.allowModels : [];
  if (allowModels.length === 0) {
    return true;
  }
  const modelId = params.modelId?.trim();
  if (!modelId) {
    return false;
  }
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  const provider = normalizeOptionalLowercaseString(params.modelProvider);
  const normalizedFull =
    provider && !normalizedModelId.includes("/")
      ? `${provider}/${normalizedModelId}`
      : normalizedModelId;
  return allowModels.some((entry) => {
    const normalized = normalizeOptionalLowercaseString(entry);
    return Boolean(
      normalized && (normalized === normalizedModelId || normalized === normalizedFull),
    );
  });
}
