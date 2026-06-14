/**
 * Normalizes and logs provider-specific tool schemas at runtime.
 */
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
  let providerDiagnostics: ProviderToolSchemaDiagnostic[] | null | undefined;
  try {
    providerDiagnostics = inspectProviderToolSchemasWithPlugin({
      provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      runtimeHandle: params.runtimeHandle,
      allowRuntimePluginLoad: params.allowRuntimePluginLoad,
      context: buildProviderToolSchemaContext(params, provider),
    });
  } catch (error) {
    log.warn(
      `provider tool schema diagnostics failed for ${params.provider}: ${formatError(error)}`,
      {
        provider: params.provider,
        toolCount: params.tools.length,
        tools: formatProviderToolDiagnosticNames(params.tools),
      },
    );
    return;
  }
  if (!Array.isArray(providerDiagnostics)) {
    return;
  }
  if (providerDiagnostics.length === 0) {
    return;
  }

  const diagnostics = providerDiagnostics.map((diagnostic) =>
    normalizeProviderToolSchemaDiagnostic(diagnostic),
  );
  const summary = summarizeProviderToolSchemaDiagnostics(diagnostics);
  log.warn(
    `provider tool schema diagnostics: ${diagnostics.length} ${diagnostics.length === 1 ? "tool" : "tools"} for ${params.provider}: ${summary}`,
    {
      provider: params.provider,
      toolCount: params.tools.length,
      diagnosticCount: diagnostics.length,
      tools: formatProviderToolDiagnosticNames(params.tools),
      diagnostics: diagnostics.map((diagnostic) => ({
        index: diagnostic.toolIndex,
        tool: diagnostic.toolName,
        violations: diagnostic.violations.slice(0, 12),
        violationCount: diagnostic.violations.length,
      })),
    },
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatProviderToolDiagnosticName(tool: AgentTool, index: number): string {
  try {
    const name = tool.name;
    return `${index}:${typeof name === "string" && name ? name : `tool[${index}]`}`;
  } catch {
    return `${index}:tool[${index}]`;
  }
}

function formatProviderToolDiagnosticNames(tools: readonly AgentTool[]): string[] {
  return tools.map((tool, index) => formatProviderToolDiagnosticName(tool, index));
}

function readProviderDiagnosticToolIndex(
  diagnostic: ProviderToolSchemaDiagnostic,
): number | undefined {
  try {
    const index = diagnostic.toolIndex;
    return typeof index === "number" && Number.isFinite(index) ? index : undefined;
  } catch {
    return undefined;
  }
}

function readProviderDiagnosticToolName(
  diagnostic: ProviderToolSchemaDiagnostic,
  toolIndex: number | undefined,
): string {
  try {
    const name = diagnostic.toolName;
    if (typeof name === "string" && name) {
      return name;
    }
  } catch {
    // Fall through to the stable index-based fallback below.
  }
  return toolIndex === undefined ? "unknown" : `tool[${toolIndex}]`;
}

function readProviderDiagnosticViolations(diagnostic: ProviderToolSchemaDiagnostic): string[] {
  try {
    const violations = diagnostic.violations;
    return Array.isArray(violations) && violations.length > 0
      ? violations.map((violation) =>
          typeof violation === "string" && violation ? violation : "unknown violation",
        )
      : ["diagnostic violations unavailable"];
  } catch {
    return ["diagnostic violations unreadable"];
  }
}

function normalizeProviderToolSchemaDiagnostic(
  diagnostic: ProviderToolSchemaDiagnostic,
): ProviderToolSchemaDiagnostic {
  const toolIndex = readProviderDiagnosticToolIndex(diagnostic);
  return {
    toolName: readProviderDiagnosticToolName(diagnostic, toolIndex),
    ...(toolIndex !== undefined ? { toolIndex } : {}),
    violations: readProviderDiagnosticViolations(diagnostic),
  };
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
