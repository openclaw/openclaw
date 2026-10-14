import {
  isStrictOpenAIJsonSchemaCompatible,
  normalizeOpenAIStrictToolParameters,
  prepareOpenAIFunctionTool,
  prepareAnthropicInputSchema,
  publishRuntimeToolInputSchema,
} from "@openclaw/ai/internal/tool-schema";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { ModelCompatConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugins/plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

type ToolDescriptor = Pick<AnyAgentTool, "name" | "description" | "parameters" | "outputSchema">;
type PreparedDescriptor = {
  readonly source: AnyAgentTool["parameters"];
  readonly normalized: AnyAgentTool["parameters"];
  readonly finalSource: AnyAgentTool["parameters"];
  readonly outputSource: AnyAgentTool["outputSchema"];
  readonly descriptor: Readonly<ToolDescriptor>;
};
type SnapshotInputs = {
  sessionId?: string;
  config?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  modelProvider?: string;
  modelId?: string;
  modelApi?: string;
  modelCompat?: ModelCompatConfig;
  tools: readonly AnyAgentTool[];
};
type DescriptorSnapshot = {
  readonly key: string;
  readonly pluginMetadataSnapshot: PluginMetadataSnapshot | undefined;
  readonly entries: readonly (PreparedDescriptor | undefined)[];
};

const snapshots = new Map<string, DescriptorSnapshot>();
registerPluginMetadataProcessMemoLifecycleClear(() => snapshots.clear());

function publishParameters(parameters: AnyAgentTool["parameters"], name: string) {
  const projected = publishRuntimeToolInputSchema(parameters, `${name}.parameters`, name);
  // Invalid schemas remain with the existing runtime quarantine owner.
  return projected.violations.length === 0 && isRecord(projected.schema)
    ? projected.schema
    : undefined;
}

function prewarmOpenAIDescriptor(
  descriptor: Readonly<ToolDescriptor & { parameters: Record<string, unknown> }>,
  compat?: ModelCompatConfig,
) {
  for (const strict of [false, true]) {
    if (strict && !isStrictOpenAIJsonSchemaCompatible(descriptor.parameters)) {
      continue;
    }
    const parameters = normalizeOpenAIStrictToolParameters(descriptor.parameters, strict, compat);
    prepareOpenAIFunctionTool(descriptor.name, descriptor.description, parameters, strict);
    if (!strict) {
      prepareOpenAIFunctionTool(descriptor.name, descriptor.description, parameters, undefined);
    }
  }
}

/** Finalization owns descriptors; retained entries never contain callable tool objects. */
export function prepareAgentToolDescriptorSnapshot(inputs: SnapshotInputs) {
  const key = JSON.stringify([
    inputs.config ? resolveRuntimeConfigCacheKey(inputs.config) : undefined,
    getPluginRegistryState()?.activeVersion,
    inputs.modelProvider,
    inputs.modelId,
    inputs.modelApi,
    inputs.modelCompat,
    inputs.tools.map((tool) => tool.name),
  ]);
  const previous = inputs.sessionId ? snapshots.get(inputs.sessionId) : undefined;
  const entries =
    previous?.key === key && previous.pluginMetadataSnapshot === inputs.pluginMetadataSnapshot
      ? previous.entries
      : undefined;

  return {
    normalized(tool: ToolDescriptor, index: number) {
      const entry = entries?.[index];
      return entry && entry.source === tool.parameters ? entry.normalized : undefined;
    },
    bind(tool: AnyAgentTool, index: number): AnyAgentTool {
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
    },
    settle(
      sources: readonly AnyAgentTool["parameters"][],
      normalized: readonly AnyAgentTool["parameters"][],
      finalized: readonly AnyAgentTool[],
      registerCleanup?: (cleanup: (reason: string) => Promise<void>) => void,
    ) {
      if (!inputs.sessionId) {
        return;
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
          normalized: normalized[index]!,
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
        return;
      }
      const sessionId = inputs.sessionId;
      const publish = () => {
        const prepared = pending.map((entry, index): PreparedDescriptor | undefined => {
          if (entry === entries?.[index]) {
            return entry;
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
          const descriptor = Object.freeze({ ...entry.descriptor, parameters, outputSchema });
          if (
            !inputs.modelApi ||
            inputs.modelApi === "openai-responses" ||
            inputs.modelApi === "openai-completions"
          ) {
            prewarmOpenAIDescriptor(descriptor, inputs.modelCompat);
          } else if (inputs.modelApi === "anthropic-messages") {
            prepareAnthropicInputSchema(parameters);
          }
          return Object.freeze({
            ...entry,
            normalized: normalizedSchema,
            finalSource:
              entry.finalSource === entry.normalized ? normalizedSchema : entry.finalSource,
            descriptor,
          });
        });
        // A late settlement may replace a newer entry; input matching makes that a cold miss.
        snapshots.delete(sessionId);
        snapshots.set(sessionId, {
          key,
          pluginMetadataSnapshot: inputs.pluginMetadataSnapshot,
          entries: Object.freeze(prepared),
        });
        pruneMapToMaxSize(snapshots, 64);
      };
      if (registerCleanup) {
        registerCleanup(async () => publish());
      } else {
        publish();
      }
    },
  };
}
