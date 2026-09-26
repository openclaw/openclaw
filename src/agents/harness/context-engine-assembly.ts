import { AsyncLocalStorage } from "node:async_hooks";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type { ContextEngine, ContextEngineRuntimeSettings } from "../../context-engine/types.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import type { ModelRef } from "../model-selection.js";
import type { ContextEngineTurnRuntimeContext } from "./context-engine-turn-outbox.js";

type AssemblyTarget = {
  contextEngine?: ContextEngine;
  sessionId: string;
  sessionKey?: string;
};

type AssemblyScope = AssemblyTarget & {
  active: boolean;
  revision: number;
  runtimeSettings?: ContextEngineRuntimeSettings;
};

const assemblyScope = new AsyncLocalStorage<AssemblyScope>();

export function buildHarnessContextEngineTurnRuntimeFacts(params: {
  runtimeSettings?: ContextEngineRuntimeSettings;
  nativeModelSelection?: ModelRef;
  fallbackAttempt: Pick<
    EmbeddedRunAttemptParams,
    "provider" | "modelId" | "modelContextWindow" | "contextTokenBudget"
  >;
}): {
  runtimeSettings?: ContextEngineRuntimeSettings;
  runtimeContext: ContextEngineTurnRuntimeContext;
} {
  const tokenBudget = params.runtimeSettings?.limits.promptTokenBudget;
  return {
    ...(params.runtimeSettings ? { runtimeSettings: params.runtimeSettings } : {}),
    // Native model identity does not attest the host's window or context cap.
    runtimeContext: params.nativeModelSelection
      ? {
          provider: params.nativeModelSelection.provider,
          modelId: params.nativeModelSelection.model,
          ...(tokenBudget != null ? { tokenBudget } : {}),
        }
      : {
          provider: params.fallbackAttempt.provider,
          modelId: params.fallbackAttempt.modelId,
          modelContextWindow: params.fallbackAttempt.modelContextWindow,
          tokenBudget: tokenBudget ?? params.fallbackAttempt.contextTokenBudget,
        },
  };
}

/** Retain assembly facts for this attempt, never for a later retry or a concurrent turn. */
export async function captureHarnessContextEngineAssembly<T>(
  target: AssemblyTarget,
  run: () => Promise<T>,
): Promise<{ result: T; runtimeSettings?: ContextEngineRuntimeSettings }> {
  const scope: AssemblyScope = {
    contextEngine: target.contextEngine,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    active: true,
    revision: 0,
  };
  try {
    const result = await assemblyScope.run(scope, run);
    return { result, runtimeSettings: scope.runtimeSettings };
  } finally {
    scope.active = false;
  }
}

/** Snapshot before plugin code runs; publish only the latest successful assembly. */
export function beginHarnessContextEngineAssembly(
  params: AssemblyTarget & { runtimeSettings: ContextEngineRuntimeSettings },
): (() => void) | undefined {
  const scope = assemblyScope.getStore();
  if (
    !scope?.active ||
    scope.contextEngine !== params.contextEngine ||
    scope.sessionId !== params.sessionId ||
    (scope.sessionKey !== undefined && scope.sessionKey !== params.sessionKey)
  ) {
    return undefined;
  }
  const revision = ++scope.revision;
  scope.runtimeSettings = undefined;
  const settings = params.runtimeSettings;
  // Project the declared fields through their normalizer. Plugin-added fields,
  // live capabilities, and later mutations must not enter the durable outbox.
  const snapshot = buildContextEngineRuntimeSettings({
    contextEngineHost: {
      id: settings.executionHost.id ?? "",
      label: settings.executionHost.label ?? "",
      capabilities: [],
    },
    mode: settings.runtime.mode,
    harnessId: settings.runtime.harnessId,
    runtimeId: settings.runtime.runtimeId,
    provider: settings.model.provider,
    requestedModel: settings.model.requested,
    resolvedModel: settings.model.resolved,
    modelFamily: settings.model.family,
    selectedContextEngineId: settings.contextEngineSelection.selectedId,
    contextEngineSelectionSource: settings.contextEngineSelection.source,
    promptTokenBudget: settings.limits.promptTokenBudget,
    maxOutputTokens: settings.limits.maxOutputTokens,
    fallbackReason: settings.diagnostics.fallbackReason,
    degradedReason: settings.diagnostics.degradedReason,
  });
  return () => {
    if (scope.active && scope.revision === revision) {
      scope.runtimeSettings = snapshot;
    }
  };
}
