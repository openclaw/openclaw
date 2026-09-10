import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveCodexAppServerPreparedAuthHandoff,
  type CodexAppServerPreparedAuth,
} from "./auth-bridge.js";
import { runBoundedCodexAppServerTurn, type CodexBoundedTurnOptions } from "./bounded-turn.js";
import { readCodexPluginConfig, resolveCodexAppServerHomeScope } from "./config.js";
import { createAttributedCodexAssistantMessage } from "./event-projector-assistant-message.js";
import { assertCodexPassiveTurnItems } from "./protocol-validators.js";

type CodexIsolatedCompletionParams = Parameters<
  NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>
>[0];
type AgentHarnessIsolatedCompletionResult = Awaited<
  ReturnType<NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>>
>;

async function resolveNativeAuthorization(
  params: CodexIsolatedCompletionParams,
  options: CodexBoundedTurnOptions,
) {
  const authorization = params.authorization;
  const pluginConfig = readCodexPluginConfig(options.pluginConfig);
  const homeScope = resolveCodexAppServerHomeScope({ appServer: pluginConfig.appServer });
  if (authorization.owner === "host") {
    if (!params.ownedLocalProcessRequired) {
      throw new Error("Codex native isolated completion requires harness-owned authorization.");
    }
    const { model, auth } = authorization;
    // Direct-host compatibility cannot substitute for a caller-required native
    // process. Reproduce only the canonical prepared Platform route; never log
    // into the operator's native home or discard authored transport settings.
    if (
      homeScope === "user" ||
      auth.mode !== "api-key" ||
      !auth.apiKey?.trim() ||
      model.provider !== "openai" ||
      params.provider !== "openai" ||
      model.id !== params.modelId ||
      model.api !== "openai-responses" ||
      model.baseUrl.replace(/\/$/u, "") !== "https://api.openai.com/v1" ||
      Object.keys(model.headers ?? {}).length > 0 ||
      Object.keys(model.params ?? {}).length > 0
    ) {
      throw new Error("Required native Codex review cannot reproduce the prepared host route.");
    }
    return {
      preparedAuth: { kind: "api-key", apiKey: auth.apiKey } satisfies CodexAppServerPreparedAuth,
      authRequirement: "api-key" as const,
    };
  }
  const authRequirement = authorization.plan.modelRoute?.authRequirement;
  const handoff = await resolveCodexAppServerPreparedAuthHandoff({
    authRequirement,
    authProfileId: authorization.plan.forwardedAuthProfileId,
    authProfileStore: authorization.authProfileStore,
    agentDir: params.agentDir,
    homeScope,
    config: params.config,
    subscriptionProfileRequiredError:
      "Prepared Codex subscription route requires a scoped native OAuth or token profile.",
    subscriptionProfileUnusableError: `Prepared Codex auth profile "${authorization.plan.forwardedAuthProfileId}" is unusable.`,
  });
  return {
    ...(handoff.preparedAuth
      ? { preparedAuth: handoff.preparedAuth }
      : { profile: handoff.authProfileId }),
    authRequirement,
    authProfileStore: authorization.authProfileStore,
  };
}

/** Runs prompt-only Codex inference on an ephemeral, ring-zero native thread. */
export async function runCodexIsolatedCompletion(
  params: CodexIsolatedCompletionParams,
  options: CodexBoundedTurnOptions,
): Promise<AgentHarnessIsolatedCompletionResult> {
  params.assertCurrent?.();
  const authSelection = await resolveNativeAuthorization(params, options);
  params.assertCurrent?.();
  const result = await runBoundedCodexAppServerTurn({
    config: params.config,
    model: {
      mode: "required",
      id: params.modelId,
    },
    ...authSelection,
    timeoutMs: params.timeoutMs,
    signal: params.abortSignal,
    assertCurrent: params.assertCurrent,
    agentDir: params.agentDir,
    options,
    taskLabel: "isolated completion",
    developerInstructions: params.systemPrompt,
    input: [{ type: "text", text: params.prompt, text_elements: [] }],
    requiredModalities: ["text"],
    isolation: "configured-transport",
    ownedLocalProcessRequired: params.ownedLocalProcessRequired,
    requireNoExternalCapabilities: true,
  });
  params.assertCurrent?.();
  assertCodexPassiveTurnItems(result.items, params.prompt, "isolated completion");
  return {
    assistant: createAttributedCodexAssistantMessage(
      {
        api: "openai-chatgpt-responses",
        provider: params.provider,
        modelId: result.model,
      },
      result.text,
      { tokenUsage: result.usage, aborted: false, promptError: null },
    ),
  };
}
