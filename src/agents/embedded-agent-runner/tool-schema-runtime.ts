import type { TSchema } from "typebox";
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

type NormalizedProviderToolSchemaDiagnostic = {
  toolName?: string;
  toolIndex?: number;
  violations: string[];
};

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

  const normalizedDiagnostics = diagnostics.map(normalizeProviderToolSchemaDiagnostic);
  const summary = summarizeProviderToolSchemaDiagnostics(normalizedDiagnostics);
  log.warn(
    `provider tool schema diagnostics: ${diagnostics.length} ${diagnostics.length === 1 ? "tool" : "tools"} for ${params.provider}: ${summary}`,
    {
      provider: params.provider,
      toolCount: params.tools.length,
      diagnosticCount: diagnostics.length,
      tools: params.tools.map((tool, index) => readProviderToolNameForDiagnostics(tool, index)),
      diagnostics: normalizedDiagnostics.map((diagnostic) => ({
        index: diagnostic.toolIndex,
        tool: diagnostic.toolName,
        violations: diagnostic.violations.slice(0, 12),
        violationCount: diagnostic.violations.length,
      })),
    },
  );
}

function summarizeProviderToolSchemaDiagnostics(
  diagnostics: readonly NormalizedProviderToolSchemaDiagnostic[],
) {
  const visible = diagnostics.slice(0, 6).map((diagnostic) => {
    const violationCount = diagnostic.violations.length;
    return `${diagnostic.toolName || "unknown"} (${violationCount} ${violationCount === 1 ? "violation" : "violations"})`;
  });
  const remaining = diagnostics.length - visible.length;
  return remaining > 0 ? `${visible.join(", ")}, +${remaining} more` : visible.join(", ");
}

function readProviderToolNameForDiagnostics(tool: AgentTool, index: number): string {
  try {
    const name = tool.name.trim();
    return `${index}:${name || `tool[${index}]`}`;
  } catch {
    return `${index}:tool[${index}]`;
  }
}

function normalizeProviderToolSchemaDiagnostic(
  diagnostic: ProviderToolSchemaDiagnostic,
): NormalizedProviderToolSchemaDiagnostic {
  return {
    toolName: readProviderDiagnosticToolName(diagnostic),
    toolIndex: readProviderDiagnosticToolIndex(diagnostic),
    violations: readProviderDiagnosticViolations(diagnostic),
  };
}

function readProviderDiagnosticToolName(
  diagnostic: ProviderToolSchemaDiagnostic,
): string | undefined {
  try {
    const name = diagnostic.toolName?.trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

function readProviderDiagnosticToolIndex(
  diagnostic: ProviderToolSchemaDiagnostic,
): number | undefined {
  try {
    return typeof diagnostic.toolIndex === "number" ? diagnostic.toolIndex : undefined;
  } catch {
    return undefined;
  }
}

function readProviderDiagnosticViolations(diagnostic: ProviderToolSchemaDiagnostic): string[] {
  try {
    return diagnostic.violations.filter(
      (violation): violation is string => typeof violation === "string",
    );
  } catch {
    return [];
  }
}
