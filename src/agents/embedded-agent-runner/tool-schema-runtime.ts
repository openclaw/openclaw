import type { TSchema } from "typebox";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
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
  hookFailureMode?: "throw" | "warn";
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

function warnProviderToolSchemaHookFailure(params: {
  provider: string;
  hookName: "normalizeToolSchemas" | "inspectToolSchemas";
  toolCount: number;
  error: unknown;
}): void {
  const provider = sanitizeForLog(params.provider);
  log.warn(
    `provider tool schema ${params.hookName} hook failed for ${provider}; keeping current runtime tools: ${sanitizeForLog(formatErrorMessage(params.error))}`,
    {
      provider,
      hookName: params.hookName,
      toolCount: params.toolCount,
    },
  );
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
  let pluginNormalized: unknown;
  try {
    pluginNormalized = normalizeProviderToolSchemasWithPlugin({
      provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      runtimeHandle: params.runtimeHandle,
      allowRuntimePluginLoad: params.allowRuntimePluginLoad,
      context: buildProviderToolSchemaContext(params, provider),
    });
  } catch (error) {
    if (params.hookFailureMode !== "warn") {
      throw error;
    }
    warnProviderToolSchemaHookFailure({
      provider,
      hookName: "normalizeToolSchemas",
      toolCount: params.tools.length,
      error,
    });
    return params.tools;
  }
  return Array.isArray(pluginNormalized)
    ? (pluginNormalized as AgentTool<TSchemaType, TResult>[])
    : params.tools;
}

/**
 * Logs provider-owned tool-schema diagnostics after normalization.
 */
export function logProviderToolSchemaDiagnostics(params: ProviderToolSchemaParams): void {
  const provider = params.provider.trim();
  let diagnostics: unknown;
  try {
    diagnostics = inspectProviderToolSchemasWithPlugin({
      provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      runtimeHandle: params.runtimeHandle,
      allowRuntimePluginLoad: params.allowRuntimePluginLoad,
      context: buildProviderToolSchemaContext(params, provider),
    });
  } catch (error) {
    if (params.hookFailureMode !== "warn") {
      throw error;
    }
    warnProviderToolSchemaHookFailure({
      provider,
      hookName: "inspectToolSchemas",
      toolCount: params.tools.length,
      error,
    });
    return;
  }
  if (!Array.isArray(diagnostics)) {
    return;
  }
  if (diagnostics.length === 0) {
    return;
  }

  const summary = summarizeProviderToolSchemaDiagnostics(diagnostics);
  log.warn(
    `provider tool schema diagnostics: ${diagnostics.length} ${diagnostics.length === 1 ? "tool" : "tools"} for ${params.provider}: ${summary}`,
    {
      provider: params.provider,
      toolCount: params.tools.length,
      diagnosticCount: diagnostics.length,
      tools: params.tools.map((tool, index) => `${index}:${tool.name}`),
      diagnostics: diagnostics.map((diagnostic) => ({
        index: diagnostic.toolIndex,
        tool: diagnostic.toolName,
        violations: diagnostic.violations.slice(0, 12),
        violationCount: diagnostic.violations.length,
      })),
    },
  );
}

function summarizeProviderToolSchemaDiagnostics(
  diagnostics: readonly ProviderToolSchemaDiagnostic[],
) {
  const visible = diagnostics.slice(0, 6).map((diagnostic) => {
    const violationCount = diagnostic.violations.length;
    return `${diagnostic.toolName || "unknown"} (${violationCount} ${violationCount === 1 ? "violation" : "violations"})`;
  });
  const remaining = diagnostics.length - visible.length;
  return remaining > 0 ? `${visible.join(", ")}, +${remaining} more` : visible.join(", ");
}
