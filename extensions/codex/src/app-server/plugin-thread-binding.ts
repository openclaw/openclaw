import { fingerprintCodexPolicy } from "./config-policy-json.js";
import type { CodexPluginThreadConfig } from "./plugin-thread-config.js";

/** Persist the complete effective app policy together with its admission inputs. */
export function fingerprintCodexPluginThreadConfig(
  config: Pick<CodexPluginThreadConfig, "inputFingerprint" | "configPatch" | "policyContext">,
): string {
  return fingerprintCodexPolicy({
    version: 2,
    inputFingerprint: config.inputFingerprint,
    configPatch: config.configPatch ?? null,
    policyContext: config.policyContext,
  });
}

export function isCodexPluginThreadBindingStale(params: {
  codexPluginsEnabled: boolean;
  bindingFingerprint?: string;
  bindingInputFingerprint?: string;
  currentInputFingerprint?: string;
  hasBindingPolicyContext?: boolean;
}): boolean {
  if (!params.codexPluginsEnabled) {
    return Boolean(
      params.bindingFingerprint || params.bindingInputFingerprint || params.hasBindingPolicyContext,
    );
  }
  if (
    !params.bindingFingerprint ||
    !params.bindingInputFingerprint ||
    !params.hasBindingPolicyContext
  ) {
    return true;
  }
  return params.bindingInputFingerprint !== params.currentInputFingerprint;
}

/** A new admission input requires revalidation, not necessarily a new native thread. */
export function hasUnchangedCodexPluginThreadPolicy(params: {
  bindingFingerprint: string;
  bindingInputFingerprint: string;
  config: CodexPluginThreadConfig;
}): boolean {
  return (
    params.bindingFingerprint ===
    fingerprintCodexPluginThreadConfig({
      inputFingerprint: params.bindingInputFingerprint,
      configPatch: params.config.configPatch,
      policyContext: params.config.policyContext,
    })
  );
}
