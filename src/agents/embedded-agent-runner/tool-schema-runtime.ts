/**
 * Normalizes and logs provider-specific tool schemas at runtime.
 */
import type { TSchema } from "typebox";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  inspectProviderToolSchemasWithPlugin,
  normalizeProviderToolSchemasWithPlugin,
} from "../../plugins/provider-runtime.js";
import type { ProviderToolSchemaDiagnostic } from "../../plugins/types.js";
import type { AgentTool } from "../runtime/index.js";
import type { AnyAgentTool } from "../tools/common.js";
import { log } from "./logger.js";

const MAX_LOGGED_PROVIDER_TOOL_SCHEMA_VIOLATIONS = 12;

type ProviderToolSchemaParams<TSchemaType extends TSchema = TSchema, TResult = unknown> = {
  tools: AgentTool<TSchemaType, TResult>[];
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
  runtimeHandle?: ProviderRuntimePluginHandle;
  allowRuntimePluginLoad?: boolean;
};

type ProviderToolSchemaLogDiagnostic = {
  toolName: string;
  toolIndex?: number;
  violations: string[];
  violationCount: number;
};

function buildProviderToolSchemaContext<TSchemaType extends TSchema = TSchema, TResult = unknown>(
  params: ProviderToolSchemaParams<TSchemaType, TResult>,
  provider: string,
) {
  return {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    model: params.model,
    tools: params.tools as unknown as AnyAgentTool[],
  };
}

/**
 * Runs provider-owned tool-schema normalization without encoding provider
 * families in the embedded runner.
 */
export function normalizeProviderToolSchemas<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
>(params: ProviderToolSchemaParams<TSchemaType, TResult>): AgentTool<TSchemaType, TResult>[] {
  const provider = params.provider.trim();
  const pluginNormalized = normalizeProviderToolSchemasWithPlugin({
    provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    runtimeHandle: params.runtimeHandle,
    allowRuntimePluginLoad: params.allowRuntimePluginLoad,
    context: buildProviderToolSchemaContext(params, provider),
  });
  return Array.isArray(pluginNormalized)
    ? (pluginNormalized as AgentTool<TSchemaType, TResult>[])
    : params.tools;
}

/**
 * Logs provider-owned tool-schema diagnostics after normalization.
 */
export function logProviderToolSchemaDiagnostics(params: ProviderToolSchemaParams): void {
  const provider = params.provider.trim();
  const providerLabel = sanitizeForLog(provider);
  const diagnostics = inspectProviderToolSchemasWithPlugin({
    provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    runtimeHandle: params.runtimeHandle,
    allowRuntimePluginLoad: params.allowRuntimePluginLoad,
    context: buildProviderToolSchemaContext(params, provider),
  });
  if (!Array.isArray(diagnostics)) {
    return;
  }
  if (diagnostics.length === 0) {
    return;
  }

  const sanitizedDiagnostics = diagnostics.map(sanitizeProviderToolSchemaDiagnostic);
  const summary = summarizeProviderToolSchemaDiagnostics(sanitizedDiagnostics);
  log.warn(
    `provider tool schema diagnostics: ${sanitizedDiagnostics.length} ${sanitizedDiagnostics.length === 1 ? "tool" : "tools"} for ${providerLabel}: ${summary}`,
    {
      provider: providerLabel,
      toolCount: params.tools.length,
      diagnosticCount: sanitizedDiagnostics.length,
      tools: params.tools.map(formatProviderToolLogLabel),
      diagnostics: sanitizedDiagnostics.map((diagnostic) => ({
        index: diagnostic.toolIndex,
        tool: diagnostic.toolName,
        violations: diagnostic.violations,
        violationCount: diagnostic.violationCount,
      })),
    },
  );
}

function sanitizeProviderToolSchemaDiagnostic(
  diagnostic: ProviderToolSchemaDiagnostic,
): ProviderToolSchemaLogDiagnostic {
  return {
    toolIndex: diagnostic.toolIndex,
    toolName: sanitizeForLog(diagnostic.toolName),
    violations: diagnostic.violations
      .slice(0, MAX_LOGGED_PROVIDER_TOOL_SCHEMA_VIOLATIONS)
      .map((violation) => sanitizeForLog(violation)),
    violationCount: diagnostic.violations.length,
  };
}

function formatProviderToolLogLabel(tool: AnyAgentTool, index: number): string {
  try {
    const name = tool.name;
    return `${index}:${typeof name === "string" && name ? sanitizeForLog(name) : `tool[${index}]`}`;
  } catch {
    return `${index}:tool[${index}]`;
  }
}

function summarizeProviderToolSchemaDiagnostics(
  diagnostics: readonly ProviderToolSchemaLogDiagnostic[],
) {
  const visible = diagnostics.slice(0, 6).map((diagnostic) => {
    const violationCount = diagnostic.violationCount;
    return `${diagnostic.toolName || "unknown"} (${violationCount} ${violationCount === 1 ? "violation" : "violations"})`;
  });
  const remaining = diagnostics.length - visible.length;
  return remaining > 0 ? `${visible.join(", ")}, +${remaining} more` : visible.join(", ");
}
