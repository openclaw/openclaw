import { isCodexAppServerLiveThreadBackgroundOnly } from "./client-runtime.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { fingerprintCodexThreadConfig } from "./thread-fingerprints.js";
import {
  buildCodexThreadRequestConfig,
  prepareCodexThreadFinalConfigPatch,
  type CodexThreadRequestContext,
} from "./thread-lifecycle-preflight.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";

/** Projection identity omits persistent instructions: qualify using warm reuse's full policy. */
export async function canRetainCodexProjectionBackgroundWork(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding,
  context: CodexThreadRequestContext,
  pluginThreadConfig: CodexPluginThreadConfig | undefined,
): Promise<boolean> {
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
  return isCodexAppServerLiveThreadBackgroundOnly(
    params.client,
    binding.threadId,
    fingerprintCodexThreadConfig(
      resumeParams,
      authProfileId,
      context.dynamicToolsFingerprint,
      binding,
    ),
  );
}
