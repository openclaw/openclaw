import type { ModelCompatConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import {
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.wrapper.js";
import { applyToolAvailabilityDescriptions } from "./agent-tools.deferred-followup.js";
import { prepareAgentToolDescriptorSnapshot } from "./agent-tools.descriptor-snapshot.js";
import { bindToolParameterSchema, normalizeToolParameters } from "./agent-tools.schema.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { isToolWrappedWithBeforeToolCallHook } from "./before-tool-call-metadata.js";

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
  const descriptors = prepareAgentToolDescriptorSnapshot({
    ...options,
    sessionId: options.hookContext.sessionId,
    pluginMetadataSnapshot: options.preparedModelRuntime?.metadataSnapshot,
  });
  const sources = options.tools.map((tool) => tool.parameters);
  const normalized = options.tools.map((tool, index) => {
    const prepared = descriptors.normalized(tool, index);
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
  const withHooks =
    options.wrapBeforeToolCallHook === false
      ? normalized
      : normalized.map((tool) =>
          typeof options.wrapBeforeToolCallHook === "function" &&
          !options.wrapBeforeToolCallHook(tool)
            ? tool
            : isToolWrappedWithBeforeToolCallHook(tool)
              ? rewrapToolWithBeforeToolCallHook(tool, options.hookContext, hookOptions)
              : wrapToolWithBeforeToolCallHook(tool, options.hookContext, hookOptions),
        );
  options.recordToolPrepStage?.("tool-hooks");
  const abortSignal = options.abortSignal;
  const withAbort = abortSignal
    ? withHooks.map((tool) => wrapToolWithAbortSignal(tool, abortSignal))
    : withHooks;
  options.recordToolPrepStage?.("abort-wrappers");
  const finalized = applyToolAvailabilityDescriptions(withAbort).map((tool, index) =>
    descriptors.bind(tool, index),
  );
  options.recordToolPrepStage?.("deferred-followup-descriptions");
  descriptors.settle(sources, normalizedSchemas, finalized, options.registerRunCleanup);
  return finalized;
}
