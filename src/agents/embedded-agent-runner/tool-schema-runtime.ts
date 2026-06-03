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
  throwOnProviderToolSchemaError?: boolean;
};

type ReadableProviderToolSchemaDiagnostic = {
  toolName: string;
  toolIndex?: number;
  violations: string[];
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
    if (params.throwOnProviderToolSchemaError) {
      throw error;
    }
    log.warn(
      `provider tool schema normalization failed for ${provider}; keeping original tool schemas`,
      { provider, toolCount: readToolCount(params.tools), error: describeProviderHookError(error) },
    );
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
    log.warn(`provider tool schema diagnostics failed for ${provider}`, {
      provider,
      toolCount: readToolCount(params.tools),
      error: describeProviderHookError(error),
    });
    return;
  }
  if (!Array.isArray(diagnostics)) {
    return;
  }
  const readableDiagnostics = readProviderToolSchemaDiagnostics(diagnostics);
  if (readableDiagnostics.length === 0) {
    return;
  }

  const summary = summarizeProviderToolSchemaDiagnostics(readableDiagnostics);
  log.warn(
    `provider tool schema diagnostics: ${readableDiagnostics.length} ${readableDiagnostics.length === 1 ? "tool" : "tools"} for ${provider}: ${summary}`,
    {
      provider,
      toolCount: readToolCount(params.tools),
      diagnosticCount: readableDiagnostics.length,
      tools: summarizeToolNames(params.tools),
      diagnostics: readableDiagnostics.map((diagnostic) => ({
        index: diagnostic.toolIndex,
        tool: diagnostic.toolName,
        violations: diagnostic.violations.slice(0, 12),
        violationCount: diagnostic.violations.length,
      })),
    },
  );
}

function summarizeProviderToolSchemaDiagnostics(
  diagnostics: readonly ReadableProviderToolSchemaDiagnostic[],
) {
  const visible = diagnostics.slice(0, 6).map((diagnostic) => {
    const violationCount = diagnostic.violations.length;
    return `${diagnostic.toolName || "unknown"} (${violationCount} ${violationCount === 1 ? "violation" : "violations"})`;
  });
  const remaining = diagnostics.length - visible.length;
  return remaining > 0 ? `${visible.join(", ")}, +${remaining} more` : visible.join(", ");
}

function describeProviderHookError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function readToolCount(tools: readonly unknown[]): number {
  try {
    return tools.length;
  } catch {
    return 0;
  }
}

function summarizeToolNames(tools: readonly AnyAgentTool[]): string[] {
  const count = readToolCount(tools);
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    try {
      const name = normalizeDiagnosticText(tools[index]?.name) ?? "unknown";
      names.push(`${index}:${name}`);
    } catch {
      names.push(`${index}:unknown`);
    }
  }
  return names;
}

function readProviderToolSchemaDiagnostics(
  diagnostics: readonly ProviderToolSchemaDiagnostic[],
): ReadableProviderToolSchemaDiagnostic[] {
  let count: number;
  try {
    count = diagnostics.length;
  } catch {
    return [{ toolName: "unknown", violations: ["diagnostics are unreadable"] }];
  }
  const readableDiagnostics: ReadableProviderToolSchemaDiagnostic[] = [];
  for (let index = 0; index < count; index += 1) {
    try {
      readableDiagnostics.push(readProviderToolSchemaDiagnostic(diagnostics[index]));
    } catch {
      readableDiagnostics.push({
        toolName: "unknown",
        toolIndex: index,
        violations: ["diagnostic is unreadable"],
      });
    }
  }
  return readableDiagnostics;
}

function readProviderToolSchemaDiagnostic(
  diagnostic: ProviderToolSchemaDiagnostic,
): ReadableProviderToolSchemaDiagnostic {
  const readableDiagnostic: ReadableProviderToolSchemaDiagnostic = {
    toolName: "unknown",
    violations: ["diagnostic is unreadable"],
  };
  try {
    readableDiagnostic.toolName = normalizeDiagnosticText(diagnostic.toolName) ?? "unknown";
  } catch {
    return readableDiagnostic;
  }
  try {
    if (typeof diagnostic.toolIndex === "number" && Number.isInteger(diagnostic.toolIndex)) {
      readableDiagnostic.toolIndex = diagnostic.toolIndex;
    }
  } catch {
    // Keep the diagnostic visible even if optional metadata is hostile.
  }
  try {
    if (Array.isArray(diagnostic.violations)) {
      readableDiagnostic.violations = normalizeViolationTexts(diagnostic.violations);
    }
  } catch {
    readableDiagnostic.violations = ["diagnostic is unreadable"];
  }
  return readableDiagnostic;
}

function normalizeViolationTexts(violations: readonly unknown[]): string[] {
  const normalized: string[] = [];
  for (const entry of violations) {
    const violation = normalizeDiagnosticText(entry);
    if (violation) {
      normalized.push(violation);
    }
  }
  return normalized.length > 0 ? normalized : ["diagnostic has no readable violations"];
}

function normalizeDiagnosticText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}
