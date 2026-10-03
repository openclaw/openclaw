import {
  isActiveHarnessContextEngine,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexContextEngineProjectionMaxChars } from "./context-engine-projection.js";
import type {
  CodexAppServerContextEngineBinding,
  CodexAppServerContextEngineProjectionBinding,
} from "./session-binding.js";

export type CodexContextEngineThreadBootstrapProjection = Pick<
  CodexAppServerContextEngineProjectionBinding,
  "mode" | "epoch" | "fingerprint"
>;

export function buildContextEngineBinding(
  params: EmbeddedRunAttemptParams,
  projection?: CodexContextEngineThreadBootstrapProjection,
): CodexAppServerContextEngineBinding | undefined {
  const contextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  const engineId = contextEngine?.info?.id?.trim();
  if (!contextEngine || !engineId) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    engineId,
    policyFingerprint: JSON.stringify({
      schemaVersion: 1,
      engineId,
      engineVersion: contextEngine.info.version,
      ownsCompaction: contextEngine.info.ownsCompaction === true,
      turnMaintenanceMode: contextEngine.info.turnMaintenanceMode,
      citationsMode: params.config?.memory?.citations,
      contextTokenBudget: params.contextTokenBudget,
      projectionMaxChars: resolveCodexContextEngineProjectionMaxChars({
        contextTokenBudget: params.contextTokenBudget,
      }),
    }),
    projection: projection
      ? {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: projection.epoch,
          fingerprint: projection.fingerprint,
        }
      : undefined,
  };
}

export function isContextEngineBindingCompatible(
  previous: CodexAppServerContextEngineBinding | undefined,
  next: CodexAppServerContextEngineBinding,
): boolean {
  return (
    previous?.schemaVersion === next.schemaVersion &&
    previous.engineId === next.engineId &&
    previous.policyFingerprint === next.policyFingerprint &&
    areContextEngineProjectionBindingsCompatible(previous.projection, next.projection)
  );
}

function areContextEngineProjectionBindingsCompatible(
  previous: CodexAppServerContextEngineProjectionBinding | undefined,
  next: CodexAppServerContextEngineProjectionBinding | undefined,
): boolean {
  if (!next) {
    return previous === undefined;
  }
  return (
    previous?.schemaVersion === next.schemaVersion &&
    previous.mode === next.mode &&
    previous.epoch === next.epoch &&
    previous.fingerprint === next.fingerprint
  );
}
