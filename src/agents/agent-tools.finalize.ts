import {
  isStrictOpenAIJsonSchemaCompatible,
  normalizeOpenAIStrictToolParameters,
  normalizeToolParameterSchema,
  prepareAnthropicInputSchema,
  publishRuntimeToolInputSchema,
} from "@openclaw/ai/internal/tool-schema";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCompatConfig } from "../config/zod-schema.model-compat.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugins/plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import { rewrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import { applyToolAvailabilityDescriptions } from "./agent-tools.deferred-followup.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

type PreparedSchema = { parameters: AnyAgentTool["parameters"] };
type PublishedSchema = { parameters: Record<string, unknown>; prewarmed: Set<string> };

function createSchemaMemo() {
  return {
    normalized: new WeakMap<object, Map<string, PreparedSchema>>(),
    published: new WeakMap<object, PublishedSchema>(),
  };
}

let processSchemas = createSchemaMemo();
let snapshotSchemas = new WeakMap<PluginMetadataSnapshot, ReturnType<typeof createSchemaMemo>>();
registerPluginMetadataProcessMemoLifecycleClear(() => {
  processSchemas = createSchemaMemo();
  snapshotSchemas = new WeakMap();
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

function publishParameters(
  memo: ReturnType<typeof createSchemaMemo>,
  parameters: AnyAgentTool["parameters"],
  name: string,
): PublishedSchema | undefined {
  const cached = memo.published.get(parameters);
  if (cached) {
    return cached;
  }
  const projected = publishRuntimeToolInputSchema(parameters, `${name}.parameters`, name);
  // Invalid schemas remain with the existing runtime quarantine owner.
  if (projected.violations.length > 0 || !isRecord(projected.schema)) {
    return undefined;
  }
  const published = { parameters: projected.schema, prewarmed: new Set<string>() };
  memo.published.set(parameters, published);
  memo.published.set(published.parameters, published);
  return published;
}

function prewarmOpenAISchema(parameters: AnyAgentTool["parameters"], compat?: ModelCompatConfig) {
  for (const strict of [false, true]) {
    if (strict && !isStrictOpenAIJsonSchemaCompatible(parameters)) {
      continue;
    }
    normalizeOpenAIStrictToolParameters(parameters, strict, compat);
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
  wrapBeforeToolCallHook?: boolean | ((tool: AnyAgentTool) => boolean);
  emitBeforeToolCallDiagnostics?: boolean;
  approvalMode?: "request" | "report" | "deny";
  abortSignal?: AbortSignal;
  recordToolPrepStage?: (name: string) => void;
};

export function finalizeAgentTools(options: FinalizeAgentToolsOptions): AnyAgentTool[] {
  finalizeAgentToolAvailability(options.tools, { beforeNormalization: true });
  const pluginMetadataSnapshot = options.preparedModelRuntime?.metadataSnapshot;
  const memo = pluginMetadataSnapshot
    ? (snapshotSchemas.get(pluginMetadataSnapshot) ?? createSchemaMemo())
    : processSchemas;
  if (pluginMetadataSnapshot) {
    snapshotSchemas.set(pluginMetadataSnapshot, memo);
  }
  // Tool definitions own schema identity. Catalog order, descriptions and run bindings do not.
  const key = JSON.stringify([
    options.modelProvider,
    options.modelId,
    options.modelApi,
    options.modelCompat,
  ]);
  const prepared = options.tools.map((tool): PreparedSchema => {
    if (!tool.parameters || typeof tool.parameters !== "object") {
      return { parameters: tool.parameters };
    }
    let variants = memo.normalized.get(tool.parameters);
    if (!variants) {
      variants = new Map();
      memo.normalized.set(tool.parameters, variants);
    }
    let entry = variants.get(key);
    if (!entry) {
      entry = {
        parameters: normalizeToolParameterSchema(tool.parameters, {
          modelProvider: options.modelProvider,
          modelId: options.modelId,
          modelCompat: options.modelCompat,
          toolName: tool.name,
        }),
      };
      variants.set(key, entry);
    }
    return entry;
  });
  const normalized = options.tools.map((tool, index) =>
    // SAFETY: Preparation preserves the tool array's positions.
    bindToolParameterSchema(tool, prepared[index]!.parameters),
  );
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
  const finalized = applyToolAvailabilityDescriptions(withAbort);
  options.recordToolPrepStage?.("deferred-followup-descriptions");
  if (finalized.length === 0) {
    return finalized;
  }
  // Settlement retains metadata only, never executable closures or the plugin snapshot.
  const pending = finalized.map(({ name, parameters, outputSchema }, index) => ({
    name,
    parameters,
    outputSchema,
    // SAFETY: Hook and availability wrappers preserve the tool array's positions.
    prepared: prepared[index]!,
  }));
  const { modelApi, modelCompat, registerRunCleanup } = options;
  const publish = () => {
    for (const entry of pending) {
      const normalizedSchema = publishParameters(memo, entry.prepared.parameters, entry.name);
      if (normalizedSchema) {
        entry.prepared.parameters = normalizedSchema.parameters;
      }
      const published = publishParameters(memo, entry.parameters, entry.name);
      if (entry.outputSchema) {
        publishParameters(memo, entry.outputSchema, entry.name);
      }
      if (!published || published.prewarmed.has(key)) {
        continue;
      }
      if (!modelApi || modelApi === "openai-responses" || modelApi === "openai-completions") {
        prewarmOpenAISchema(published.parameters, modelCompat);
      } else if (modelApi === "anthropic-messages") {
        prepareAnthropicInputSchema(published.parameters);
      }
      published.prewarmed.add(key);
    }
  };
  if (registerRunCleanup) {
    registerRunCleanup(async () => publish());
  } else {
    publish();
  }
  return finalized.map((tool) => {
    const parameters = memo.published.get(tool.parameters)?.parameters ?? tool.parameters;
    const outputSchema = tool.outputSchema
      ? (memo.published.get(tool.outputSchema)?.parameters ?? tool.outputSchema)
      : undefined;
    return parameters === tool.parameters && outputSchema === tool.outputSchema
      ? tool
      : copyAgentToolMetadata(tool, { ...tool, parameters, outputSchema });
  });
}
