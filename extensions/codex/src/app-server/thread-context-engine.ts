import { isActiveHarnessContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentHarnessSessionRuntimeParamsV1 } from "openclaw/plugin-sdk/codex-mcp-projection";
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
  params: AgentHarnessSessionRuntimeParamsV1,
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
  const previousProjection = previous?.projection;
  const nextProjection = next.projection;
  return (
    previous?.schemaVersion === next.schemaVersion &&
    previous.engineId === next.engineId &&
    previous.policyFingerprint === next.policyFingerprint &&
    (!nextProjection
      ? previousProjection === undefined
      : previousProjection?.schemaVersion === nextProjection.schemaVersion &&
        previousProjection.mode === nextProjection.mode &&
        previousProjection.epoch === nextProjection.epoch &&
        previousProjection.fingerprint === nextProjection.fingerprint)
  );
}
