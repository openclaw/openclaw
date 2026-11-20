import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { isAgentToolRepeatGuardEnabled } from "./agent-scope.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import type { ApplyPatchContainmentSource } from "./apply-patch-containment-hint.js";
import { resolveImageSanitizationLimits } from "./image-sanitization.js";
import { resolveExecToolConfig } from "./lazy-exec-tool.js";
import { participationPermission } from "./participation-ceiling.js";
import { resolveSessionPermissionCoreToolPolicy } from "./session-permission-exec-mode.js";
import { resolveToolFsConfig } from "./tool-fs-policy.js";

type CoreToolPolicyOptions = Pick<
  OpenClawCodingToolsOptions,
  | "config"
  | "agentId"
  | "sessionPermissionPolicy"
  | "participationCeiling"
  | "requireWorkspaceOnly"
  | "trigger"
  | "memoryFlushWritePath"
  | "modelProvider"
  | "modelId"
  | "modelContextWindowTokens"
  | "modelHasVision"
>;

/** Resolve once on the Gateway; placement hosts consume these secret-free facts. */
export function prepareCoreToolPolicy(
  options: CoreToolPolicyOptions,
  execConfig = resolveExecToolConfig({ cfg: options.config, agentId: options.agentId }),
) {
  const sessionPolicy = options.sessionPermissionPolicy
    ? resolveSessionPermissionCoreToolPolicy(options.sessionPermissionPolicy)
    : undefined;
  const workspaceOnly =
    options.participationCeiling !== undefined ||
    options.requireWorkspaceOnly === true ||
    options.trigger === "memory" ||
    (sessionPolicy?.workspaceOnly ??
      resolveToolFsConfig({ cfg: options.config, agentId: options.agentId }).workspaceOnly ===
        true);
  const readOnly =
    sessionPolicy?.readOnly === true ||
    (options.participationCeiling !== undefined &&
      participationPermission(options.participationCeiling) === "read-only");
  const patch = execConfig.applyPatch;
  const applyPatchContainmentSource: ApplyPatchContainmentSource =
    options.participationCeiling || options.requireWorkspaceOnly
      ? "required-root"
      : sessionPolicy
        ? "session"
        : "config";
  return {
    workspaceOnly,
    // Participation is Gateway-local; ordinary worker policies retain their wire shape.
    ...(options.participationCeiling ? { strictWorkspaceRoot: true } : {}),
    readOnly,
    applyPatchEnabled:
      !readOnly &&
      patch?.enabled !== false &&
      isApplyPatchAllowedForModel(options, patch?.allowModels),
    applyPatchWorkspaceOnly:
      workspaceOnly || (sessionPolicy?.applyPatchWorkspaceOnly ?? patch?.workspaceOnly === true),
    applyPatchContainmentSource,
    imageSanitization: resolveImageSanitizationLimits(options.config),
    modelContextWindowTokens: options.modelContextWindowTokens,
    modelHasVision: options.modelHasVision,
    // Worker turns run the repeat guard themselves and follow tools.loopDetection.enabled.
    ...(isAgentToolRepeatGuardEnabled(options.config, options.agentId)
      ? {}
      : { toolRepeatGuard: false as const }),
    ...(options.trigger === "memory" && options.memoryFlushWritePath
      ? { memoryFlushWritePath: options.memoryFlushWritePath }
      : {}),
  };
}

function isApplyPatchAllowedForModel(
  options: Pick<CoreToolPolicyOptions, "modelProvider" | "modelId">,
  allowModels?: string[],
) {
  if (!Array.isArray(allowModels) || allowModels.length === 0) {
    return true;
  }
  const normalizedModelId = normalizeOptionalLowercaseString(options.modelId);
  if (!normalizedModelId) {
    return false;
  }
  const provider = normalizeOptionalLowercaseString(options.modelProvider);
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
