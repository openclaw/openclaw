import { isHostScopedAgentToolActive } from "../agent-tools.ring-zero-context.js";
import { appendCurrentInboundContext } from "../embedded-agent-runner/run/runtime-context-prompt.js";
import { buildAgentInternalEventContext } from "../internal-events.js";
import { projectRuntimeContextFragments } from "../internal-runtime-context.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "../provider-secret-egress.js";
import { isRuntimeToolAllowed, isToolAllowedByPolicies } from "../tool-policy-match.js";
import {
  isSystemAgentOnlyAllowlist,
  preparePluginHarnessToolPolicies,
  resolvePluginHarnessDenyAllToolPolicyPrompt,
  type ResolvedPluginHarnessToolPolicies,
} from "./execution-environment.js";
import { assertPluginHarnessConversationToolPolicySupport } from "./support.js";
import type { AgentHarness } from "./types.js";

export async function preparePluginHarnessParams(
  params: import("./types.js").AgentHarnessAttemptParamsV2,
  harness: AgentHarness,
  nativePermissionsConsented: boolean,
  setInputAttachmentReadAllowed: (allowed: boolean) => void,
  hasRuntimePluginToolGrant: boolean,
): Promise<import("./types.js").AgentHarnessAttemptParamsV2> {
  const boundary = "plugin harness handoff";
  const resolvedApiKey = params.resolvedApiKey
    ? unwrapSecretSentinelsForProviderEgress(params.resolvedApiKey, boundary)
    : params.resolvedApiKey;
  const model = unwrapModelHeaderSentinelsForProviderEgress(params.model, boundary);
  const currentInboundContext = foldRuntimeEventContext(params);
  const preparedParams =
    model === params.model &&
    resolvedApiKey === params.resolvedApiKey &&
    currentInboundContext === params.currentInboundContext
      ? params
      : { ...params, model, resolvedApiKey, currentInboundContext };
  const policies = await preparePluginHarnessToolPolicies(
    preparedParams,
    harness.conversationToolPolicySupport === "exact"
      ? harness.conversationToolPolicySafeDenyTools
      : undefined,
    harness.conversationToolPolicyNativeTools,
  );
  if (policies.requiresLiveToolAuthority) {
    // Native-runtime consent does not waive a separate revocable delegation grant.
    assertPluginHarnessConversationToolPolicySupport(harness, true);
  }
  const policyParams = {
    ...preparedParams,
    pluginHarnessToolPolicySafeDeniedTools:
      policies.safeDeniedToolNames.length > 0 ? policies.safeDeniedToolNames : undefined,
    pluginHarnessToolPolicyRestricted: policies.toolPolicyRestricted,
    pluginHarnessToolPolicyScope: hasRuntimePluginToolGrant ? "turn" : policies.toolPolicyScope,
  };
  const effectiveParams = nativePermissionsConsented
    ? policyParams
    : applyPluginHarnessDenyAllToolPolicy(policyParams, policies);
  setInputAttachmentReadAllowed(
    isRuntimeToolAllowed("read", effectiveParams.toolsAllow) &&
      isRuntimeToolAllowed("read", effectiveParams.toolExecutionAllow) &&
      isToolAllowedByPolicies("read", [
        policies.senderPolicy,
        policies.groupPolicy,
        ...policies.runtimePolicies,
      ]),
  );
  return effectiveParams;
}

// Plugin harnesses read only the prepared inbound context, so a runtime-event turn
// (prompt RUNTIME_EVENT_USER_PROMPT) must carry its events there or the model never
// sees them. Uses the embedded/CLI fragment builder and the steer's projection.
function foldRuntimeEventContext(
  params: import("./types.js").AgentHarnessAttemptParamsV2,
): import("./types.js").AgentHarnessAttemptParamsV2["currentInboundContext"] {
  const fragments = buildAgentInternalEventContext(
    params.internalEvents,
    params.runtimeContextFragments,
  ).filter((fragment) => fragment.text.trim());
  if (fragments.length === 0) {
    return params.currentInboundContext;
  }
  return appendCurrentInboundContext(
    params.currentInboundContext,
    fragments,
    projectRuntimeContextFragments(fragments),
  );
}

function applyPluginHarnessDenyAllToolPolicy(
  params: import("./types.js").AgentHarnessAttemptParamsV2,
  policies: ResolvedPluginHarnessToolPolicies,
): import("./types.js").AgentHarnessAttemptParamsV2 {
  if (isHostScopedAgentToolActive("openclaw") && isSystemAgentOnlyAllowlist(params.toolsAllow)) {
    return params;
  }
  const prompt = resolvePluginHarnessDenyAllToolPolicyPrompt(policies);
  if (!prompt) {
    return params;
  }
  return {
    ...params,
    toolsAllow: [],
    extraSystemPrompt: appendPluginHarnessToolPolicyPrompt(params.extraSystemPrompt, prompt),
  };
}

function appendPluginHarnessToolPolicyPrompt(existing: string | undefined, prompt: string): string {
  const trimmed = existing?.trim();
  if (!trimmed) {
    return prompt;
  }
  return trimmed.includes(prompt) ? trimmed : `${trimmed}\n\n${prompt}`;
}
