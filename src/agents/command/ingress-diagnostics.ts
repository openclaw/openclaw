import { getRuntimeConfig } from "../../config/io.js";
import { isDiagnosticsEnabled, emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { estimateAggregateUsageCost } from "../../utils/usage-format.js";
import type { EmbeddedAgentMeta, EmbeddedAgentRunMeta } from "../embedded-agent-runner/types.js";
import { hasBillableUsage, toDiagnosticUsage } from "../usage.js";
import type { AgentCommandIngressOpts } from "./types.js";

type AgentCommandResult = {
  meta?: {
    agentMeta?: Partial<EmbeddedAgentMeta>;
    durationMs?: EmbeddedAgentRunMeta["durationMs"];
  };
};

/** Emit the ingress-only model usage diagnostic after a completed agent run. */
export function emitIngressModelUsageDiagnostic(
  result: AgentCommandResult,
  opts: AgentCommandIngressOpts,
  agentDir: string,
): void {
  const cfg = getRuntimeConfig();
  if (!isDiagnosticsEnabled(cfg)) {
    return;
  }
  const agentMeta = result.meta?.agentMeta;
  const usage = agentMeta?.diagnosticUsage ?? agentMeta?.usage;
  if (!agentMeta || !hasBillableUsage(usage)) {
    return;
  }

  const providerUsed = agentMeta.provider ?? "";
  const modelUsed = agentMeta.model ?? "";
  const costUsd = estimateAggregateUsageCost({
    usage,
    provider: providerUsed,
    model: modelUsed,
    config: cfg,
    agentDir,
  });

  emitTrustedDiagnosticEvent({
    type: "model.usage",
    sessionKey: opts.sessionKey,
    sessionId: agentMeta.sessionId,
    channel: opts.runContext?.messageChannel ?? opts.messageChannel ?? opts.channel ?? "http",
    agentId: opts.agentId,
    provider: providerUsed,
    model: modelUsed,
    usage: toDiagnosticUsage(usage),
    lastCallUsage: agentMeta.lastCallUsage,
    context: {
      limit: agentMeta.contextTokens,
      ...(agentMeta.promptTokens !== undefined ? { used: agentMeta.promptTokens } : {}),
    },
    costUsd,
    durationMs: result.meta?.durationMs,
  });
}
