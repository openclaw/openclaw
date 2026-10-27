import {
  isStrictOpenAIJsonSchemaCompatible,
  normalizeOpenAIStrictToolParameters,
  normalizeToolParameterSchema,
  prepareAnthropicInputSchema,
  publishRuntimeToolInputSchema,
  type ToolParameterSchemaOptions,
} from "@openclaw/ai/internal/tool-schema";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { ModelCompatConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugins/plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import { rewrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import { applyToolAvailabilityDescriptions } from "./agent-tools.deferred-followup.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { applyInteractionModelTools } from "./interaction-model-tools.js";

type ToolDescriptor = Pick<AnyAgentTool, "name" | "description" | "parameters" | "outputSchema">;
type PreparedDescriptor = {
  readonly source: AnyAgentTool["parameters"];
  readonly normalized: AnyAgentTool["parameters"];
  readonly finalSource: AnyAgentTool["parameters"];
  readonly outputSource: AnyAgentTool["outputSchema"];
  readonly descriptor: Readonly<ToolDescriptor>;
};
type DescriptorSnapshot = {
  readonly key: string;
  readonly pluginMetadataSnapshot: PluginMetadataSnapshot | undefined;
  readonly entries: readonly (PreparedDescriptor | undefined)[];
};

const snapshots = new Map<string, DescriptorSnapshot>();
// Seeds a session's first attempt from the latest publication with the same inputs;
// per-tool identity checks still gate every reuse.
const latestByKey = new Map<string, DescriptorSnapshot>();
registerPluginMetadataProcessMemoLifecycleClear(() => {
  snapshots.clear();
  latestByKey.clear();
});

function isObjectSchemaWithNoRequiredParams(schema: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  const type = schema.type;
  const hasObjectType =
    type === "object" || (Array.isArray(type) && type.some((entry) => entry === "object"));
  if (!hasObjectType) {
    return false;
  }
  return !schemaHasRequiredParams(schema);
}

function schemaHasRequiredParams(schema: Record<string, unknown>): boolean {
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    return true;
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const variants = schema[key];
    if (!Array.isArray(variants)) {
      continue;
    }
    if (variants.some((variant) => isRecord(variant) && schemaHasRequiredParams(variant))) {
      return true;
    }
  }
  return false;
}

function normalizeToolParameters(
  tool: AnyAgentTool,
  options?: ToolParameterSchemaOptions,
): AnyAgentTool {
  const schema =
    tool.parameters && typeof tool.parameters === "object" ? tool.parameters : undefined;
  if (!schema) {
    return tool;
  }
  const parameters = normalizeToolParameterSchema(schema, { ...options, toolName: tool.name });
  return bindToolParameterSchema(tool, parameters);
}

/** Bind a prepared descriptor to this attempt's argument preparation and metadata. */
function bindToolParameterSchema(
  tool: AnyAgentTool,
  parameters: AnyAgentTool["parameters"],
): AnyAgentTool {
  const normalized = { ...tool, parameters };
  if (isObjectSchemaWithNoRequiredParams(parameters)) {
    normalized.prepareArguments = (args: unknown) => {
      const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
      return prepared === null || prepared === undefined ? {} : prepared;
    };
  }
  return copyAgentToolMetadata(tool, normalized);
}

function publishParameters(parameters: AnyAgentTool["parameters"], name: string) {
  const projected = publishRuntimeToolInputSchema(parameters, `${name}.parameters`, name);
  // Invalid schemas remain with the existing runtime quarantine owner.
  return projected.violations.length === 0 && isRecord(projected.schema)
    ? projected.schema
    : undefined;
}

function prewarmOpenAISchema(
  descriptor: Readonly<ToolDescriptor & { parameters: Record<string, unknown> }>,
  compat?: ModelCompatConfig,
) {
  for (const strict of [false, true]) {
    if (strict && !isStrictOpenAIJsonSchemaCompatible(descriptor.parameters)) {
      continue;
    }
    normalizeOpenAIStrictToolParameters(descriptor.parameters, strict, compat);
  }
}

type FinalizeAgentToolsOptions = {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  preparedModelRuntime?: { metadataSnapshot: PluginMetadataSnapshot };
  registerRunCleanup?: (cleanup: (reason: string) => Promise<void>) => void;
  modelProvider?: string;
  modelId?: string;
  modelApi?: string;
  modelCompat?: ModelCompatConfig;
  hookContext: HookContext;
  interactionModelContext?: { policyAgentId?: string };
  wrapBeforeToolCallHook?: boolean | ((tool: AnyAgentTool) => boolean);
  emitBeforeToolCallDiagnostics?: boolean;
  approvalMode?: "request" | "report" | "deny";
  abortSignal?: AbortSignal;
  recordToolPrepStage?: (name: string) => void;
};

export function finalizeAgentTools(options: FinalizeAgentToolsOptions): AnyAgentTool[] {
  finalizeAgentToolAvailability(options.tools, { beforeNormalization: true });
  const sessionId = options.hookContext.sessionId;
  const pluginMetadataSnapshot = options.preparedModelRuntime?.metadataSnapshot;
  const modelApi = options.modelApi;
  const modelCompat = options.modelCompat;
  const key = JSON.stringify([
    options.config ? resolveRuntimeConfigCacheKey(options.config) : undefined,
    getPluginRegistryState()?.activeVersion,
    options.modelProvider,
    options.modelId,
    modelApi,
    modelCompat,
    options.tools.map((tool) => tool.name),
  ]);
  const own = sessionId ? snapshots.get(sessionId) : undefined;
  const previous = own?.key === key ? own : latestByKey.get(key);
  const entries =
    previous?.pluginMetadataSnapshot === pluginMetadataSnapshot ? previous?.entries : undefined;
  const sources = options.tools.map((tool) => tool.parameters);
  const normalized = options.tools.map((tool, index) => {
    const entry = entries?.[index];
    const prepared = entry && entry.source === tool.parameters ? entry.normalized : undefined;
    return prepared
      ? bindToolParameterSchema(tool, prepared)
      : normalizeToolParameters(tool, {
          modelProvider: options.modelProvider,
          modelId: options.modelId,
          modelCompat: options.modelCompat,
        });
  });
  const normalizedSchemas = normalized.map((tool) => tool.parameters);
  options.recordToolPrepStage?.("schema-normalization");
  const hookOptions = {
    emitDiagnostics: options.emitBeforeToolCallDiagnostics,
    ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
  };
  const hookContext =
    options.hookContext.config || !options.config
      ? options.hookContext
      : { ...options.hookContext, config: options.config };
  const withHooks =
    options.wrapBeforeToolCallHook === false
      ? normalized
      : normalized.map((tool) =>
          typeof options.wrapBeforeToolCallHook === "function" &&
          !options.wrapBeforeToolCallHook(tool)
            ? tool
            : rewrapToolWithBeforeToolCallHook(tool, hookContext, hookOptions),
        );
  options.recordToolPrepStage?.("tool-hooks");
  const abortSignal = options.abortSignal;
  const withAbort = abortSignal
    ? withHooks.map((tool) => wrapToolWithAbortSignal(tool, abortSignal))
    : withHooks;
  options.recordToolPrepStage?.("abort-wrappers");
  const finalized = applyToolAvailabilityDescriptions(withAbort).map((tool, index) => {
    const entry = entries?.[index];
    if (
      !entry ||
      tool.description !== entry.descriptor.description ||
      tool.parameters !== entry.finalSource ||
      tool.outputSchema !== entry.outputSource
    ) {
      return tool;
    }
    return copyAgentToolMetadata(tool, { ...tool, ...entry.descriptor });
  });
  options.recordToolPrepStage?.("deferred-followup-descriptions");
  // Cache original action descriptors; only the outer model-facing contract becomes a task.
  const finish = () =>
    options.interactionModelContext
      ? applyInteractionModelTools({
          tools: finalized,
          config: options.config,
          agentId: hookContext.agentId,
          policyAgentId: options.interactionModelContext.policyAgentId,
          hookContext,
          wrapBeforeToolCallHook: options.wrapBeforeToolCallHook !== false,
        })
      : finalized;
  const registerCleanup = options.registerRunCleanup;
  if (!sessionId) {
    return finish();
  }
  // Capture only descriptor data before returning to the attempt.
  const pending = finalized.map((tool, index): PreparedDescriptor => {
    const entry = entries?.[index];
    if (
      entry &&
      entry.source === sources[index] &&
      entry.descriptor.parameters === tool.parameters &&
      entry.descriptor.outputSchema === tool.outputSchema &&
      entry.descriptor.description === tool.description
    ) {
      // Keep the original output source when another tool changes this catalog.
      return entry;
    }
    return {
      // SAFETY: Finalization maps the same ordered tools without filtering or reordering.
      source: sources[index]!,
      // SAFETY: Normalized schemas are captured from that same positional finalization pass.
      normalized: normalizedSchemas[index]!,
      finalSource: tool.parameters,
      outputSource: tool.outputSchema,
      descriptor: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        outputSchema: tool.outputSchema,
      },
    };
  });
  if (
    entries?.length === pending.length &&
    pending.every((entry, index) => entry === entries[index])
  ) {
    return finish();
  }
  const publish = () => {
    // Concurrent cold sessions settle after one another; reuse what they already published.
    const latest = latestByKey.get(key);
    const published =
      latest?.pluginMetadataSnapshot === pluginMetadataSnapshot ? latest?.entries : undefined;
    const prepared = pending.map((entry, index): PreparedDescriptor | undefined => {
      if (entry === entries?.[index]) {
        return entry;
      }
      const shared = published?.[index];
      if (
        shared &&
        shared.descriptor.name === entry.descriptor.name &&
        shared.source === entry.source &&
        shared.outputSource === entry.outputSource &&
        shared.descriptor.description === entry.descriptor.description &&
        (entry.finalSource === entry.normalized
          ? shared.finalSource === shared.normalized
          : shared.finalSource === entry.finalSource)
      ) {
        return shared;
      }
      const normalizedSchema = publishParameters(entry.normalized, entry.descriptor.name);
      const parameters =
        entry.finalSource === entry.normalized
          ? normalizedSchema
          : publishParameters(entry.finalSource, entry.descriptor.name);
      const outputSchema = entry.outputSource
        ? publishParameters(entry.outputSource, entry.descriptor.name)
        : undefined;
      if (!normalizedSchema || !parameters || (entry.outputSource && !outputSchema)) {
        return undefined;
      }
      const descriptor = { ...entry.descriptor, parameters, outputSchema };
      if (!modelApi || modelApi === "openai-responses" || modelApi === "openai-completions") {
        prewarmOpenAISchema(descriptor, modelCompat);
      } else if (modelApi === "anthropic-messages") {
        prepareAnthropicInputSchema(parameters);
      }
      return {
        source: entry.source,
        outputSource: entry.outputSource,
        normalized: normalizedSchema,
        finalSource: entry.finalSource === entry.normalized ? normalizedSchema : entry.finalSource,
        descriptor,
      };
    });
    // A late settlement may replace a newer entry; input matching makes that a cold miss.
    const snapshot = {
      key,
      pluginMetadataSnapshot,
      entries: prepared,
    };
    snapshots.delete(sessionId);
    snapshots.set(sessionId, snapshot);
    pruneMapToMaxSize(snapshots, 64);
    latestByKey.delete(key);
    latestByKey.set(key, snapshot);
    pruneMapToMaxSize(latestByKey, 16);
  };
  if (registerCleanup) {
    registerCleanup(async () => publish());
  } else {
    publish();
  }
  return finish();
}
