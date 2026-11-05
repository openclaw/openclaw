import { isCodexAppServerLiveThreadBackgroundOnly } from "./client-runtime.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import {
  areCodexDynamicToolFingerprintsCompatible,
  fingerprintCodexThreadConfig,
} from "./thread-fingerprints.js";
import {
  buildCodexThreadRequestConfig,
  prepareCodexThreadFinalConfigPatch,
  type CodexThreadRequestContext,
} from "./thread-lifecycle-preflight.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";

type CodexProjectionBackgroundRetentionReason =
  | "retained"
  | "client-mismatch"
  | "engine-policy-mismatch"
  | "tool-mismatch"
  | "not-background-only"
  | "plugin-policy-mismatch"
  | "immutable-config-mismatch";

/** Return the first disqualifier; later checks are unevaluated, not matching. */
export async function qualifyCodexProjectionBackgroundWork(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding,
  preflight: Pick<
    CodexThreadRequestContext,
    "contextEngineBinding" | "dynamicToolsFingerprint" | "legacyDynamicToolsFingerprint"
  >,
  prepareRequestContext: () => Promise<CodexThreadRequestContext>,
  buildLoadedPluginThreadConfig: (
    binding: CodexAppServerThreadBinding,
  ) => Promise<CodexPluginThreadConfig | undefined>,
): Promise<CodexProjectionBackgroundRetentionReason> {
  if (binding.clientId !== params.client.getInstanceId()) {
    return "client-mismatch";
  }
  const next = preflight.contextEngineBinding;
  if (
    !next ||
    binding.contextEngine?.engineId !== next.engineId ||
    binding.contextEngine?.policyFingerprint !== next.policyFingerprint
  ) {
    return "engine-policy-mismatch";
  }
  if (
    binding.dynamicToolsFingerprint &&
    !areCodexDynamicToolFingerprintsCompatible({
      previous: binding.dynamicToolsFingerprint,
      next: preflight.dynamicToolsFingerprint,
      nextLegacy: preflight.legacyDynamicToolsFingerprint,
    })
  ) {
    return "tool-mismatch";
  }
  if (!isCodexAppServerLiveThreadBackgroundOnly(params.client, binding.threadId)) {
    return "not-background-only";
  }
  const pluginThreadConfig = await buildLoadedPluginThreadConfig(binding);
  if (pluginThreadConfig && pluginThreadConfig.fingerprint !== binding.pluginAppsFingerprint) {
    return "plugin-policy-mismatch";
  }
  const context = await prepareRequestContext();
  // Projection identity omits persistent instructions: use warm reuse's full policy.
  const finalConfig = await prepareCodexThreadFinalConfigPatch(
    params,
    context.nativeModelInputTools,
    binding,
  );
  const pluginConfig =
    pluginThreadConfig?.configPatch ??
    (params.pluginThreadConfig?.enabled && binding.pluginAppPolicyContext
      ? buildCodexPluginAppsConfigPatchFromPolicyContext(binding.pluginAppPolicyContext)
      : undefined);
  const authProfileId =
    binding.connectionScope === "supervision"
      ? undefined
      : (params.params.authProfileId ?? binding.authProfileId);
  const resumeParams = await context.buildResumeParams(
    binding,
    authProfileId,
    buildCodexThreadRequestConfig(params, context, pluginConfig, finalConfig.configPatch),
  );
  // Ownership can change while configuration is prepared; do not mislabel that as policy drift.
  if (!isCodexAppServerLiveThreadBackgroundOnly(params.client, binding.threadId)) {
    return "not-background-only";
  }
  return isCodexAppServerLiveThreadBackgroundOnly(
    params.client,
    binding.threadId,
    fingerprintCodexThreadConfig(
      resumeParams,
      authProfileId,
      context.dynamicToolsFingerprint,
      binding,
      params,
    ),
  )
    ? "retained"
    : "immutable-config-mismatch";
}
