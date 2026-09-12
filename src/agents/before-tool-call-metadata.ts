import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import type { AnyAgentTool } from "./tools/common.js";

export type BeforeToolCallDiagnosticOptions = {
  emitDiagnostics: boolean;
  protectNetworkErrors?: boolean;
  approvalMode?: "request" | "report" | "deny";
};

const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const BEFORE_TOOL_CALL_SOURCE_TOOL = Symbol("beforeToolCallSourceTool");

type BeforeToolCallMetadata = {
  diagnosticOptions: BeforeToolCallDiagnosticOptions;
  hookContext?: HookContext;
};

const metadataByMarker = new WeakMap<object, BeforeToolCallMetadata>();

type BeforeToolCallMetadataTool = AnyAgentTool & {
  [BEFORE_TOOL_CALL_WRAPPED]?: object;
  [BEFORE_TOOL_CALL_SOURCE_TOOL]?: AnyAgentTool;
};

function withBeforeToolCallMetadata(tool: AnyAgentTool): BeforeToolCallMetadataTool {
  return tool;
}

function getBeforeToolCallMetadata(tool: AnyAgentTool): BeforeToolCallMetadata | undefined {
  const marker = withBeforeToolCallMetadata(tool)[BEFORE_TOOL_CALL_WRAPPED];
  return marker ? metadataByMarker.get(marker) : undefined;
}

export function setBeforeToolCallMetadata(
  tool: AnyAgentTool,
  sourceTool: AnyAgentTool,
  metadata: BeforeToolCallMetadata,
): void {
  // Empty frozen keys survive spreads and plugin views without projecting host context.
  const marker = Object.freeze({});
  metadataByMarker.set(marker, metadata);
  Object.defineProperties(tool, {
    [BEFORE_TOOL_CALL_WRAPPED]: { value: marker, enumerable: true },
    // Source execution must retain any outer plugin view's live admission.
    [BEFORE_TOOL_CALL_SOURCE_TOOL]: { value: sourceTool, enumerable: false },
  });
}

export function getBeforeToolCallSourceTool(tool: AnyAgentTool): AnyAgentTool | undefined {
  return withBeforeToolCallMetadata(tool)[BEFORE_TOOL_CALL_SOURCE_TOOL];
}

export function getBeforeToolCallHookContext(tool: AnyAgentTool): HookContext | undefined {
  return getBeforeToolCallMetadata(tool)?.hookContext;
}

export function clearBeforeToolCallWrappedMarker(tool: AnyAgentTool): void {
  delete withBeforeToolCallMetadata(tool)[BEFORE_TOOL_CALL_WRAPPED];
}

/** Return true when a tool already carries the before_tool_call wrapper marker. */
export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  return getBeforeToolCallMetadata(tool) !== undefined;
}

/** Toggle diagnostic event emission on an existing before_tool_call wrapper. */
export function setBeforeToolCallDiagnosticsEnabled(tool: AnyAgentTool, enabled: boolean): void {
  const options = getBeforeToolCallMetadata(tool)?.diagnosticOptions;
  if (options) {
    options.emitDiagnostics = enabled;
  }
}

export function getBeforeToolCallDiagnosticOptions(
  tool: AnyAgentTool,
): BeforeToolCallDiagnosticOptions | undefined {
  return getBeforeToolCallMetadata(tool)?.diagnosticOptions;
}

/** Copy before_tool_call marker metadata when another wrapper replaces a tool. */
export function copyBeforeToolCallHookMarker(source: AnyAgentTool, target: AnyAgentTool): void {
  const marker = withBeforeToolCallMetadata(source)[BEFORE_TOOL_CALL_WRAPPED];
  if (!marker || !metadataByMarker.has(marker)) {
    return;
  }
  Object.defineProperty(target, BEFORE_TOOL_CALL_WRAPPED, {
    value: marker,
    enumerable: true,
  });
  const sourceTool = getBeforeToolCallSourceTool(source);
  if (sourceTool) {
    Object.defineProperty(target, BEFORE_TOOL_CALL_SOURCE_TOOL, {
      value: sourceTool,
      enumerable: false,
    });
  }
}
