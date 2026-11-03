import {
  isHostScopedAgentToolActive,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { isSystemAgentOnlyCodexDynamicToolAllowlist } from "./dynamic-tool-profile.js";
import type { JsonObject } from "./protocol.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { fingerprintRestrictedThreadConfig } from "./thread-fingerprints.js";
import type { CodexThreadRequestContext } from "./thread-lifecycle-preflight.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";

/** Request restrictions isolate auxiliary work; configured conversation restrictions can persist. */
export function isTransientCodexRestrictedTurn(
  params: CodexStartOrResumeThreadParams["params"],
  hostSystemAgentActive: boolean,
): boolean {
  return (
    // Lifetime also covers additive grants that leave native tools unrestricted.
    params.pluginHarnessToolPolicyScope === "turn" ||
    params.disableTools === true ||
    params.requireWorkspaceOnly === true ||
    (params.pluginHarnessToolPolicyScope === undefined &&
      params.toolsAllow !== undefined &&
      !(hostSystemAgentActive && isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow))) ||
    params.delegationCapability === "report_only" ||
    params.trigger === "memory"
  );
}

export function resolveCodexProjectionStartupBinding(options: {
  params: EmbeddedRunAttemptParamsV2;
  binding: CodexAppServerThreadBinding | undefined;
  nativeToolSurfaceEnabled: boolean;
}): CodexAppServerThreadBinding | undefined {
  if (isTransientCodexRestrictedTurn(options.params, isHostScopedAgentToolActive("openclaw"))) {
    return undefined;
  }
  if (!options.nativeToolSurfaceEnabled && !options.binding?.restrictedThreadConfigFingerprint) {
    return undefined;
  }
  return options.binding;
}

export function isRestrictedThreadConfigCompatible(
  params: CodexStartOrResumeThreadParams,
  context: Pick<
    CodexThreadRequestContext,
    "restrictedToolSurface" | "dynamicToolsFingerprint" | "hostSystemAgentActive"
  > & {
    binding: CodexAppServerThreadBinding;
    requireRestrictedThreadConfigFingerprint?: boolean;
  },
  request: JsonObject,
  authProfileId: string | undefined,
): boolean {
  if (!context.requireRestrictedThreadConfigFingerprint) {
    return true;
  }
  return (
    Boolean(context.binding.nativeToolPolicyRestricted) === context.restrictedToolSurface &&
    context.binding.restrictedThreadConfigFingerprint ===
      fingerprintRestrictedThreadConfig(
        request,
        authProfileId,
        context.dynamicToolsFingerprint,
        params.params,
        context.hostSystemAgentActive,
        context.binding,
      )
  );
}

export function buildRestrictedThreadConfigFingerprint(
  params: CodexStartOrResumeThreadParams,
  context: Pick<CodexThreadRequestContext, "dynamicToolsFingerprint" | "hostSystemAgentActive"> & {
    preserveExistingBinding: boolean;
  },
  request: JsonObject,
  selection: Parameters<typeof fingerprintRestrictedThreadConfig>[5],
): string | undefined {
  if (params.nativeCodeModeEnabled !== false || context.preserveExistingBinding) {
    return undefined;
  }
  return fingerprintRestrictedThreadConfig(
    request,
    params.params.authProfileId,
    context.dynamicToolsFingerprint,
    params.params,
    context.hostSystemAgentActive,
    selection,
  );
}
