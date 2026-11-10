import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.js";
import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence.js";
import { resolveExpiredRuntimeContextContentBytes } from "../context-engine/transcript-byte-limit.js";
import { readSessionTranscriptAccountingAsync } from "../gateway/session-transcript-readers.js";
import { getPreparedRuntimeAuthProfileStoreSnapshot } from "./auth-profiles.js";
import type { CompactEmbeddedAgentSessionParams } from "./embedded-agent-runner/compact.types.js";
import {
  applyConfiguredProviderOverrides,
  resolveConfiguredProviderConfig,
} from "./embedded-agent-runner/model.configured-overrides.js";
import { resolveBundledStaticCatalogModel } from "./embedded-agent-runner/model.static-catalog.js";
import { resolveEmbeddedSessionContextLimits } from "./embedded-agent-runner/run/session-context-limits.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";
import { SessionManager } from "./sessions/session-manager.js";
import { resolveTranscriptPolicy } from "./transcript-policy.js";

/** Correct compaction pressure without changing raw storage or acquisition accounting. */
export async function readCompactionTranscriptBytes(params: {
  target: SessionTranscriptRuntimeTarget;
  rawBytes: number | undefined;
  maxBytes: number | undefined;
  contextTokenBudget: number | undefined;
  signal?: AbortSignal;
  runtime: Pick<
    CompactEmbeddedAgentSessionParams,
    | "provider"
    | "model"
    | "config"
    | "agentId"
    | "agentDir"
    | "workspaceDir"
    | "authProfileId"
    | "authProfileIdSource"
    | "runtimeAuthPlan"
  >;
}): Promise<number | undefined> {
  const { maxBytes, runtime, signal } = params;
  let rawBytes = params.rawBytes;
  try {
    rawBytes ??= (
      await readSessionTranscriptAccountingAsync(
        params.target,
        { includeByteSize: true, includeUsage: false },
        signal,
      )
    ).byteSize;
    signal?.throwIfAborted();
    if (
      rawBytes === undefined ||
      maxBytes === undefined ||
      rawBytes < maxBytes ||
      runtime.provider !== "anthropic" ||
      !runtime.model
    ) {
      return rawBytes;
    }
    // Use the current route, never the last stored assistant: another transport
    // or OAuth route can replay these same carriers as ordinary user content.
    const plan =
      runtime.runtimeAuthPlan ??
      prepareAgentRuntimeAuth({
        provider: runtime.provider,
        modelId: runtime.model,
        config: runtime.config,
        agentId: runtime.agentId,
        agentDir: runtime.agentDir,
        workspaceDir: runtime.workspaceDir,
        authProfileStore: getPreparedRuntimeAuthProfileStoreSnapshot(runtime.agentDir),
        sessionAuthProfileId: runtime.authProfileId,
        sessionAuthProfileSource: runtime.authProfileIdSource,
        harnessId: "openclaw",
      }).plan;
    const model = applyConfiguredProviderOverrides({
      provider: runtime.provider,
      modelId: runtime.model,
      cfg: runtime.config,
      workspaceDir: runtime.workspaceDir,
      manifestAlias: { provider: runtime.provider },
      providerConfig: resolveConfiguredProviderConfig(runtime.config, runtime.provider),
      discoveredModel: resolveBundledStaticCatalogModel({
        provider: runtime.provider,
        modelId: runtime.model,
        cfg: runtime.config,
        workspaceDir: runtime.workspaceDir,
      }),
    });
    if (
      model?.api !== "anthropic-messages" ||
      !resolveTranscriptPolicy({
        provider: runtime.provider,
        modelId: runtime.model,
        modelApi: model.api,
        model,
        config: runtime.config,
        workspaceDir: runtime.workspaceDir,
        directApiKey: plan.selectedAuthMode === "api-key" || plan.selectedAuthMode === "api_key",
      }).inHistorySystemUpdates
    ) {
      return rawBytes;
    }
    const context = await SessionManager.openModelContextAsync(params.target, {
      signal,
      limits: resolveEmbeddedSessionContextLimits({
        contextTokenBudget: params.contextTokenBudget,
      }),
    });
    signal?.throwIfAborted();
    const expired = resolveExpiredRuntimeContextContentBytes(
      context.buildSessionContext().messages,
    );
    // Keep envelopes and every row outside the bounded read charged. Subtracting
    // only proven expired content cannot undercount omitted, still-live history.
    return Math.max(0, rawBytes - [...expired.values()].reduce((sum, bytes) => sum + bytes, 0));
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SessionTranscriptReadFenceError) {
      throw error;
    }
    return rawBytes;
  }
}
