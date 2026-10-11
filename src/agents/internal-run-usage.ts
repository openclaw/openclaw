import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { estimateAggregateUsageCost } from "../utils/usage-format.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { hasBillableUsage, toDiagnosticUsage } from "./usage.js";

/** Detached maintenance settles its own usage, never the foreground conversation's totals. */
export function emitInternalRunUsageDiagnostic(
  result: EmbeddedAgentRunResult,
  params: {
    config: OpenClawConfig;
    agentId: string;
    agentDir?: string;
    sessionId: string;
    sessionKey: string;
    provider?: string;
    model?: string;
  },
): void {
  if (!isDiagnosticsEnabled(params.config)) {
    return;
  }
  const meta = result.meta?.agentMeta;
  const usage = meta?.diagnosticUsage ?? meta?.usage;
  if (!hasBillableUsage(usage)) {
    return;
  }
  const provider = meta?.provider ?? params.provider;
  const model = meta?.model ?? params.model;
  emitTrustedDiagnosticEvent({
    type: "model.usage",
    ...(result.diagnosticTrace
      ? {
          trace: freezeDiagnosticTraceContext(
            createChildDiagnosticTraceContext(result.diagnosticTrace),
          ),
        }
      : {}),
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider,
    model,
    usage: toDiagnosticUsage(usage),
    lastCallUsage: meta?.lastCallUsage,
    context: {
      limit: meta?.contextTokens,
      ...(meta?.promptTokens !== undefined ? { used: meta.promptTokens } : {}),
    },
    costUsd: estimateAggregateUsageCost({
      usage,
      provider,
      model,
      config: params.config,
      agentDir: params.agentDir,
    }),
    durationMs: result.meta?.durationMs,
  });
}
