import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../embedded-agent-runner/run/types.js";
import type { ContextEngineTurnRuntimeContext } from "./context-engine-turn-outbox.js";

type AssemblyTarget = {
  sessionId: string;
  sessionKey?: string;
  provider?: string | null;
  modelId?: string | null;
};

export type ContextEngineAssemblySnapshot = AssemblyTarget & {
  tokenBudget?: number;
};

type AssemblyAttempt = { snapshot?: ContextEngineAssemblySnapshot };
// Core selection and SDK assembly can load in different runtime chunks. Share the
// scope carrier, never a last-budget value or settings across attempts.
const assemblyAttempt = resolveGlobalSingleton(
  Symbol.for("openclaw.contextEngineAssemblyAttempt"),
  () => new AsyncLocalStorage<AssemblyAttempt>(),
);

/** Each concrete retry owns its assembly facts; rejected and concurrent attempts share none. */
export async function runWithContextEngineAssemblyAttempt<T>(run: () => Promise<T>) {
  const attempt: AssemblyAttempt = {};
  const result = await assemblyAttempt.run(attempt, run);
  return { result, assembly: attempt.snapshot };
}

export function clearContextEngineAssemblySnapshot(): void {
  const attempt = assemblyAttempt.getStore();
  if (attempt) {
    attempt.snapshot = undefined;
  }
}

export function recordContextEngineAssemblySnapshot(snapshot: ContextEngineAssemblySnapshot): void {
  const attempt = assemblyAttempt.getStore();
  if (attempt) {
    attempt.snapshot = snapshot;
  }
}

export function readContextEngineAssemblyBudget(
  target: AssemblyTarget,
  snapshot: ContextEngineAssemblySnapshot | null | undefined = assemblyAttempt.getStore()?.snapshot,
): number | undefined {
  if (
    !snapshot ||
    snapshot.sessionId !== target.sessionId ||
    snapshot.sessionKey !== target.sessionKey ||
    snapshot.provider !== target.provider ||
    snapshot.modelId !== target.modelId
  ) {
    return undefined;
  }
  return snapshot.tokenBudget;
}

export function resolveContextEngineCompletionRuntimeContext(
  params: EmbeddedRunAttemptParams,
  result: EmbeddedRunAttemptResult,
  nativeSession: boolean,
  assembly: ContextEngineAssemblySnapshot | undefined,
): ContextEngineTurnRuntimeContext {
  const acceptedModel = result.runtimeModelSelection ?? {
    provider: params.provider,
    model: params.modelId,
  };
  const assemblyBudget = readContextEngineAssemblyBudget(
    {
      sessionId: result.sessionIdUsed,
      sessionKey: params.sessionKey,
      provider: acceptedModel.provider,
      modelId: acceptedModel.model,
    },
    assembly ?? null,
  );
  // A startup estimate may describe the thread's previous model.
  const reportedContextTokens =
    result.contextTokensSource === "runtime" || result.contextTokensSource === "runtime-configured"
      ? result.contextTokens
      : undefined;
  if (
    result.runtimeModelSelection &&
    (nativeSession ||
      acceptedModel.provider !== params.provider ||
      acceptedModel.model !== params.modelId)
  ) {
    // Native identity alone does not attest the host's window or context cap.
    return {
      provider: acceptedModel.provider,
      modelId: acceptedModel.model,
      ...(reportedContextTokens === undefined ? {} : { modelContextWindow: reportedContextTokens }),
      ...(assemblyBudget === undefined && reportedContextTokens === undefined
        ? {}
        : { tokenBudget: assemblyBudget ?? reportedContextTokens }),
    };
  }
  return {
    provider: params.provider,
    modelId: params.modelId,
    modelContextWindow:
      params.contextTokenBudget === undefined
        ? (reportedContextTokens ?? params.modelContextWindow)
        : params.modelContextWindow,
    tokenBudget:
      assemblyBudget ??
      params.contextTokenBudget ??
      reportedContextTokens ??
      params.authoredContextTokenCap,
  };
}
