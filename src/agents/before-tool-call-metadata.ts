import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import type { AnyAgentTool } from "./tools/common.js";

export type BeforeToolCallDiagnosticOptions = {
  emitDiagnostics: boolean;
  protectNetworkErrors?: boolean;
  approvalMode?: "request" | "report" | "deny";
};

const BEFORE_TOOL_CALL_WRAPPED = Symbol.for("openclaw.beforeToolCallWrapped");
const BEFORE_TOOL_CALL_SOURCE_TOOL = Symbol.for("openclaw.beforeToolCallSourceTool");

export type ToolExecutionWrapper = (tool: AnyAgentTool) => AnyAgentTool;

type BeforeToolCallMetadata = {
  options: BeforeToolCallDiagnosticOptions;
  hookContext?: HookContext;
  executionWrappers?: readonly ToolExecutionWrapper[];
};

// Symbols survive spreads and plugin views without projecting host context.
// Source-transformed SDK modules and compiled hosts must recognize the same marker.
const metadataByMarker = resolveGlobalSingleton(
  Symbol.for("openclaw.beforeToolCallMetadata"),
  () => new WeakMap<symbol, BeforeToolCallMetadata>(),
);

type BeforeToolCallMetadataTool = AnyAgentTool & {
  [BEFORE_TOOL_CALL_WRAPPED]?: symbol;
  [BEFORE_TOOL_CALL_SOURCE_TOOL]?: AnyAgentTool;
};

function getBeforeToolCallMetadata(
  tool: BeforeToolCallMetadataTool,
): BeforeToolCallMetadata | undefined {
  const marker = tool[BEFORE_TOOL_CALL_WRAPPED];
  return marker ? metadataByMarker.get(marker) : undefined;
}

export function bindBeforeToolCallMetadata(
  tool: AnyAgentTool,
  { sourceTool, ...metadata }: BeforeToolCallMetadata & { sourceTool: AnyAgentTool },
): void {
  const marker = Symbol("beforeToolCallMetadata");
  metadataByMarker.set(marker, metadata);
  Object.defineProperties(tool, {
    [BEFORE_TOOL_CALL_WRAPPED]: { value: marker, enumerable: true },
    // Reading through a plugin view retains every outer source-execution guard.
    [BEFORE_TOOL_CALL_SOURCE_TOOL]: { value: sourceTool, enumerable: false },
  });
}

export function getBeforeToolCallSourceTool(
  tool: BeforeToolCallMetadataTool,
): AnyAgentTool | undefined {
  return tool[BEFORE_TOOL_CALL_SOURCE_TOOL];
}

export function getBeforeToolCallExecutionWrappers(
  tool: AnyAgentTool,
): readonly ToolExecutionWrapper[] {
  return getBeforeToolCallMetadata(tool)?.executionWrappers ?? [];
}

export function getBeforeToolCallHookContext(tool: AnyAgentTool): HookContext | undefined {
  return getBeforeToolCallMetadata(tool)?.hookContext;
}

export function clearBeforeToolCallWrappedMarker(tool: BeforeToolCallMetadataTool): void {
  delete tool[BEFORE_TOOL_CALL_WRAPPED];
}

/** Return true when a tool already carries the before_tool_call wrapper state. */
export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  return getBeforeToolCallMetadata(tool) !== undefined;
}

/** Toggle diagnostic event emission on an existing before_tool_call wrapper. */
export function setBeforeToolCallDiagnosticsEnabled(tool: AnyAgentTool, enabled: boolean): void {
  const options = getBeforeToolCallMetadata(tool)?.options;
  if (options) {
    options.emitDiagnostics = enabled;
  }
}

export function getBeforeToolCallDiagnosticOptions(
  tool: AnyAgentTool,
): BeforeToolCallDiagnosticOptions | undefined {
  return getBeforeToolCallMetadata(tool)?.options;
}

/** Preserve exact hook state and the guarded source edge when another wrapper replaces a tool. */
export function copyBeforeToolCallMetadata(
  source: BeforeToolCallMetadataTool,
  target: AnyAgentTool,
  wrapExecution?: ToolExecutionWrapper,
): void {
  const sourceMarker = source[BEFORE_TOOL_CALL_WRAPPED];
  const metadata = sourceMarker ? metadataByMarker.get(sourceMarker) : undefined;
  if (!sourceMarker || !metadata) {
    return;
  }
  const marker = wrapExecution ? Symbol("beforeToolCallMetadata") : sourceMarker;
  if (wrapExecution) {
    metadataByMarker.set(marker, {
      ...metadata,
      executionWrappers: Object.freeze([...(metadata.executionWrappers ?? []), wrapExecution]),
    });
  }
  // Normalizers may already carry the marker. Reattaching it to a plugin view
  // invokes plugin admission even though no metadata changes.
  const attached = Object.getOwnPropertyDescriptor(target, BEFORE_TOOL_CALL_WRAPPED);
  if (attached?.value !== marker || !attached.enumerable) {
    Object.defineProperty(target, BEFORE_TOOL_CALL_WRAPPED, { value: marker, enumerable: true });
  }
  const sourceTool = getBeforeToolCallSourceTool(source);
  if (sourceTool) {
    Object.defineProperty(target, BEFORE_TOOL_CALL_SOURCE_TOOL, {
      value: sourceTool,
      enumerable: false,
    });
  }
}
