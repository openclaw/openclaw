import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexAppServerPreparedAuthHandoff } from "./auth-bridge.js";
import type { CodexAppServerPreparedAuth } from "./auth-types.js";
import { resolveCodexBoundedTurnIsolation } from "./bounded-turn-isolation.js";
import { runBoundedCodexAppServerTurn, type CodexBoundedTurnOptions } from "./bounded-turn.js";
import { resolveCodexAppServerHomeScope } from "./config.js";
import { createAttributedCodexAssistantMessage } from "./event-projector-assistant-message.js";
import { assertCodexPassiveTurnItems } from "./protocol-validators.js";

type CodexIsolatedCompletionParams = Parameters<
  NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>
>[0];
type AgentHarnessIsolatedCompletionResult = Awaited<
  ReturnType<NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>>
>;

/** Runs prompt-only Codex inference on an ephemeral, ring-zero native thread. */
export async function runCodexIsolatedCompletion(
  params: CodexIsolatedCompletionParams,
  options: CodexBoundedTurnOptions,
): Promise<AgentHarnessIsolatedCompletionResult> {
  params.assertCurrent?.();
  const authorization = params.authorization;
  const pluginConfig = options.pluginConfig ?? {};
  const homeScope = resolveCodexAppServerHomeScope({ appServer: pluginConfig.appServer });
  let preparedAuth: CodexAppServerPreparedAuth | undefined;
  let profile: string | undefined;
  let baseUrl: string | undefined;
  let authRequirement: "api-key" | "subscription" | undefined;
  let modelId = params.modelId;
  if (authorization.owner === "host") {
    const { model, auth } = authorization;
    // The host resolved this exact endpoint and credential. Never reinterpret
    // an OAuth token as an API key or fall back to ambient native authentication.
    if (model.api !== "openai-responses" || auth.mode !== "api-key" || !auth.apiKey) {
      throw new Error(
        "Codex native isolated completion requires prepared Responses API-key auth or a harness-owned OAuth profile.",
      );
    }
    if (Object.keys(model.headers ?? {}).length > 0) {
      throw new Error("Codex native isolated completion cannot preserve prepared custom headers.");
    }
    baseUrl = model.baseUrl;
    if (!baseUrl) {
      throw new Error("Codex native isolated completion requires its prepared Responses endpoint.");
    }
    modelId = model.id;
    authRequirement = "api-key";
    preparedAuth = { kind: "api-key", apiKey: auth.apiKey };
  } else {
    authRequirement = authorization.plan.modelRoute?.authRequirement;
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
    preparedAuth = handoff.preparedAuth;
    profile = preparedAuth ? undefined : handoff.authProfileId;
    if (homeScope === "agent") {
      baseUrl = authorization.plan.modelRoute?.baseUrl;
    }
  }
  params.assertCurrent?.();
  const isolation = resolveCodexBoundedTurnIsolation(options);
  if (authRequirement === "api-key" && !baseUrl) {
    throw new Error("Codex native isolated completion requires its prepared Responses endpoint.");
  }
  if (authRequirement === "api-key" && isolation !== "private-stdio") {
    throw new Error(
      "Prepared Codex API routes require a private stdio app-server; no direct fallback was attempted.",
    );
  }
  const result = await runBoundedCodexAppServerTurn({
    config: params.config,
    model: {
      mode: "required",
      id: modelId,
    },
    ...(preparedAuth ? { preparedAuth } : { profile }),
    ...(baseUrl
      ? {
          modelProvider: "openai",
          threadConfig: { openai_base_url: baseUrl },
          requireInferenceRoute: authRequirement === "api-key",
        }
      : {}),
    authRequirement,
    timeoutMs: params.timeoutMs,
    thinkLevel: params.thinkLevel,
    signal: params.abortSignal,
    assertCurrent: params.assertCurrent,
    agentDir: params.agentDir,
    authProfileStore:
      authorization.owner === "harness" ? authorization.authProfileStore : undefined,
    options,
    taskLabel: "isolated completion",
    developerInstructions: params.systemPrompt,
    input: [{ type: "text", text: params.prompt, text_elements: [] }],
    requiredModalities: ["text"],
    isolation,
    requireNoExternalCapabilities: true,
    allowEmptyText: params.outputTextPolicy === "strict-visible",
  });
  params.assertCurrent?.();
  assertCodexPassiveTurnItems(result.items, params.prompt, "isolated completion", {
    allowManagedHookPrompts: result.managedHooksEnabled,
  });
  return {
    assistant: createAttributedCodexAssistantMessage(
      {
        api: authRequirement === "api-key" ? "openai-responses" : "openai-chatgpt-responses",
        provider: params.provider,
        modelId: result.model,
      },
      result.text,
      { tokenUsage: result.usage, aborted: false, promptError: null },
    ),
  };
}
