import { createHash } from "node:crypto";
import type {
  AgentMessage,
  ContextEngineProjection,
} from "openclaw/plugin-sdk/agent-harness-runtime";
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
> & {
  /** Final selection identity; the ordinary fingerprint admits the previous native prefix. */
  deliveredFingerprint?: string;
};

export function resolveCodexHistorySelection(
  messages: AgentMessage[],
  source: ContextEngineProjection | undefined,
  previousFingerprint: string | undefined,
): { projection: CodexContextEngineThreadBootstrapProjection; prefixLength: number | undefined } {
  const hash = createHash("sha256").update(
    JSON.stringify([source?.mode ?? "per_turn", source?.epoch, source?.fingerprint]),
  );
  const fingerprint = () => `selection-v1:${hash.copy().digest("hex")}`;
  let prefixLength = fingerprint() === previousFingerprint ? 0 : undefined;
  for (let index = 0; index < messages.length; index++) {
    const serialized = JSON.stringify(messages[index]);
    hash.update(`${Buffer.byteLength(serialized)}:`);
    hash.update(serialized);
    if (fingerprint() === previousFingerprint) {
      prefixLength = index + 1;
    }
  }
  const deliveredFingerprint = fingerprint();
  return {
    projection: {
      mode: "thread_bootstrap",
      epoch: source?.epoch?.trim() || "selected-history",
      fingerprint: prefixLength === undefined ? deliveredFingerprint : previousFingerprint,
      deliveredFingerprint,
    },
    prefixLength,
  };
}

export function buildContextEngineBinding(
  params: AgentHarnessSessionRuntimeParamsV1,
  projection?: CodexContextEngineThreadBootstrapProjection,
  acknowledged = false,
): CodexAppServerContextEngineBinding | undefined {
  const contextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  const engineId = contextEngine?.info?.id?.trim();
  if (!contextEngine || !engineId) {
    return undefined;
  }
  const configuredContextBudget = params.authoredContextTokenCap
    ? Math.min(params.authoredContextTokenCap, params.contextTokenBudget ?? Infinity)
    : undefined;
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
      contextTokenBudget: configuredContextBudget ?? params.contextTokenBudget,
      ...(configuredContextBudget
        ? {
            historyCarrier: "thread/inject_items",
            modelProvider: params.provider,
            model: params.modelId,
          }
        : {}),
      projectionMaxChars: resolveCodexContextEngineProjectionMaxChars({
        contextTokenBudget: configuredContextBudget ?? params.contextTokenBudget,
      }),
    }),
    projection: projection
      ? {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: projection.epoch,
          fingerprint:
            (acknowledged ? projection.deliveredFingerprint : undefined) ?? projection.fingerprint,
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
