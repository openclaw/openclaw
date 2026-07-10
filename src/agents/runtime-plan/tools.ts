/**
 * Applies runtime-plan or provider fallback tool schema policy. The helpers
 * normalize tool schemas, preserve owner metadata across cloned definitions,
 * and emit provider diagnostics.
 */
import type { TSchema } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { copyPluginToolMeta } from "../../plugins/tools.js";
import { copyBeforeToolCallHookMarker } from "../before-tool-call-metadata.js";
import { copyChannelAgentToolMeta } from "../channel-tools.js";
import {
  logProviderToolSchemaDiagnostics,
  normalizeProviderToolSchemas,
} from "../embedded-agent-runner/tool-schema-runtime.js";
import type { AgentTool } from "../runtime/index.js";
import {
  filterProviderNormalizableTools,
  projectRuntimeToolInputSchema,
  type RuntimeToolSchemaDiagnostic,
} from "../tool-schema-projection.js";
import { copyToolTerminalPresentation } from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { AgentRuntimePlan } from "./types.js";

type AgentRuntimeToolPolicyParams<TSchemaType extends TSchema = TSchema, TResult = unknown> = {
  runtimePlan?: AgentRuntimePlan;
  tools: AgentTool<TSchemaType, TResult>[];
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
  runtimeHandle?: ProviderRuntimePluginHandle;
  allowProviderRuntimePluginLoad?: boolean;
  /**
   * Invoked on every normalization, including with an empty list, so
   * consumers can observe the all-clear and retire stale quarantine state.
   */
  onPreNormalizationSchemaDiagnostics?: (
    diagnostics: readonly RuntimeToolSchemaDiagnostic[],
    tools: readonly AgentTool<TSchemaType, TResult>[],
  ) => void;
};

/** Builds the provider/runtime context passed into runtime-plan tool hooks. */
function runtimePlanToolContext(params: {
  workspaceDir?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
}) {
  return {
    workspaceDir: params.workspaceDir,
    modelApi: params.modelApi ?? undefined,
    model: params.model,
  };
}

// Normalizers may return cloned tool definitions. Preserve owner and private
// execution metadata so downstream dispatch keeps the same policy and result contract.
function copyRuntimeToolMetadata(source: AgentTool, target: AgentTool): void {
  if (source === target) {
    return;
  }
  const catalogMode = (source as AnyAgentTool).catalogMode;
  if (catalogMode && (target as AnyAgentTool).catalogMode !== catalogMode) {
    (target as AnyAgentTool).catalogMode = catalogMode;
  }
  copyPluginToolMeta(source as never, target as never);
  copyChannelAgentToolMeta(source as never, target as never);
  copyBeforeToolCallHookMarker(source as never, target as never);
  copyToolTerminalPresentation(source as never, target as never);
}

const inertSchemaNormalizationExecute: AnyAgentTool["execute"] = async () => ({
  content: [],
  details: undefined,
});

type RuntimeToolSchemaNormalizationEntry<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
> = {
  name: string;
  normalizationInput: AgentTool<TSchemaType, TResult>;
  sourceSnapshot: AgentTool<TSchemaType, TResult>;
};

function createRuntimeToolSchemaNormalizationEntry<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
>(
  source: AgentTool<TSchemaType, TResult>,
): RuntimeToolSchemaNormalizationEntry<TSchemaType, TResult> | undefined {
  try {
    const name = source.name;
    const sourceWithLifecycle = source as AnyAgentTool;
    const label = source.label;
    const description = source.description;
    const sourceParameters = source.parameters;
    const execute = source.execute;
    const hideFromChannelProgress = source.hideFromChannelProgress;
    const prepareArguments = source.prepareArguments;
    const executionMode = source.executionMode;
    const displaySummary = sourceWithLifecycle.displaySummary;
    const catalogMode = sourceWithLifecycle.catalogMode;
    const requiredClientCaps = sourceWithLifecycle.requiredClientCaps;
    const prepareBeforeToolCallParams = sourceWithLifecycle.prepareBeforeToolCallParams;
    const finalizeBeforeToolCallParams = sourceWithLifecycle.finalizeBeforeToolCallParams;
    const sourceSnapshot = {
      name,
      ...(label === undefined ? {} : { label }),
      ...(description === undefined ? {} : { description }),
      parameters: sourceParameters,
      ...(hideFromChannelProgress === undefined
        ? {}
        : { hideFromChannelProgress }),
      ...(prepareArguments ? { prepareArguments: prepareArguments.bind(source) } : {}),
      ...(executionMode === undefined ? {} : { executionMode }),
      ...(displaySummary === undefined ? {} : { displaySummary }),
      ...(catalogMode === undefined ? {} : { catalogMode }),
      ...(requiredClientCaps === undefined ? {} : { requiredClientCaps: [...requiredClientCaps] }),
      ...(prepareBeforeToolCallParams
        ? {
            prepareBeforeToolCallParams: prepareBeforeToolCallParams.bind(source),
          }
        : {}),
      ...(finalizeBeforeToolCallParams
        ? {
            finalizeBeforeToolCallParams: finalizeBeforeToolCallParams.bind(source),
          }
        : {}),
    } as AgentTool<TSchemaType, TResult>;
    Object.defineProperty(sourceSnapshot, "execute", {
      configurable: true,
      enumerable: typeof execute === "function",
      value:
        typeof execute === "function"
          ? execute.bind(source)
          : (inertSchemaNormalizationExecute as AgentTool<TSchemaType, TResult>["execute"]),
      writable: true,
    });
    copyRuntimeToolMetadata(source, sourceSnapshot);
    const parameters =
      sourceParameters === undefined
        ? undefined
        : projectRuntimeToolInputSchema(sourceParameters, `${name}.parameters`).schema;
    const normalizationInput = {
      name,
      ...(label === undefined ? {} : { label }),
      ...(description === undefined ? {} : { description }),
      parameters: parameters as TSchemaType,
    } as AgentTool<TSchemaType, TResult>;
    Object.defineProperty(normalizationInput, "execute", {
      configurable: true,
      enumerable: false,
      value: inertSchemaNormalizationExecute as AgentTool<TSchemaType, TResult>["execute"],
      writable: false,
    });
    return { name, sourceSnapshot, normalizationInput };
  } catch {
    return undefined;
  }
}

/**
 * Runs a schema hook against detached tool projections, then applies only its
 * schema output to captured source behavior. Added/unmatched tools are dropped.
 */
export function applyRuntimeToolSchemaNormalization<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
>(params: {
  tools: AgentTool<TSchemaType, TResult>[];
  normalize: (
    tools: AgentTool<TSchemaType, TResult>[],
  ) => AgentTool<TSchemaType, TResult>[] | null | undefined;
}): AgentTool<TSchemaType, TResult>[] {
  const entries = params.tools.flatMap((source) => {
    const entry = createRuntimeToolSchemaNormalizationEntry(source);
    return entry ? [entry] : [];
  });
  const normalizationInputs = entries.map((entry) => entry.normalizationInput);
  const normalized = params.normalize(normalizationInputs);
  const normalizedTools = Array.isArray(normalized) ? normalized : normalizationInputs;
  const sourcesByUniqueName = new Map<
    string,
    RuntimeToolSchemaNormalizationEntry<TSchemaType, TResult>
  >();
  const duplicateNames = new Set<string>();
  for (const entry of entries) {
    const { name } = entry;
    if (sourcesByUniqueName.has(name)) {
      duplicateNames.add(name);
      sourcesByUniqueName.delete(name);
      continue;
    }
    if (!duplicateNames.has(name)) {
      sourcesByUniqueName.set(name, entry);
    }
  }
  const usedSources = new Set<RuntimeToolSchemaNormalizationEntry<TSchemaType, TResult>>();
  const projectedTools: AgentTool<TSchemaType, TResult>[] = [];
  for (const [index, target] of normalizedTools.entries()) {
    let targetName: string;
    let targetParameters: TSchemaType;
    try {
      targetName = target.name;
      targetParameters = target.parameters;
    } catch {
      continue;
    }
    const indexedSource = entries[index];
    const source =
      indexedSource?.name === targetName ? indexedSource : sourcesByUniqueName.get(targetName);
    if (!source || usedSources.has(source)) {
      continue;
    }
    const projectedParameters =
      targetParameters === undefined
        ? targetParameters
        : projectRuntimeToolInputSchema(targetParameters, `${targetName}.parameters`).schema;
    usedSources.add(source);
    const projected = {
      ...source.sourceSnapshot,
      parameters: projectedParameters as TSchemaType,
    } as AgentTool<TSchemaType, TResult>;
    copyRuntimeToolMetadata(source.sourceSnapshot, projected);
    projectedTools.push(projected);
  }
  return projectedTools;
}

/** Normalizes tool schemas through a runtime plan or provider fallback policy. */
export function normalizeAgentRuntimeTools<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
>(params: AgentRuntimeToolPolicyParams<TSchemaType, TResult>): AgentTool<TSchemaType, TResult>[] {
  const planContext = runtimePlanToolContext(params);
  const normalizableToolProjection = filterProviderNormalizableTools(params.tools);
  params.onPreNormalizationSchemaDiagnostics?.(
    normalizableToolProjection.diagnostics,
    params.tools,
  );
  const normalizableTools = [...normalizableToolProjection.tools] as AgentTool<
    TSchemaType,
    TResult
  >[];
  return applyRuntimeToolSchemaNormalization({
    tools: normalizableTools,
    normalize: (tools) =>
      params.runtimePlan?.tools.normalize(tools, planContext) ??
      normalizeProviderToolSchemas({
        tools,
        provider: params.provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env ?? process.env,
        modelId: params.modelId,
        modelApi: params.modelApi,
        model: params.model,
        runtimeHandle: params.runtimeHandle,
        allowRuntimePluginLoad: params.allowProviderRuntimePluginLoad,
      }),
  });
}

/** Emits runtime-plan or provider fallback diagnostics for normalized tools. */
export function logAgentRuntimeToolDiagnostics(params: AgentRuntimeToolPolicyParams): void {
  const planContext = runtimePlanToolContext(params);
  if (params.runtimePlan) {
    params.runtimePlan.tools.logDiagnostics(params.tools, planContext);
    return;
  }
  logProviderToolSchemaDiagnostics({
    tools: params.tools,
    provider: params.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env ?? process.env,
    modelId: params.modelId,
    modelApi: params.modelApi,
    model: params.model,
    runtimeHandle: params.runtimeHandle,
  });
}
