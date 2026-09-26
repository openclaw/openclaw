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

type BeforeToolCallMetadata = {
  options: BeforeToolCallDiagnosticOptions;
  hookContext?: HookContext;
};

// Frozen keys survive spreads and plugin views without projecting host context.
// Source-transformed SDK modules and compiled hosts must recognize the same marker.
const metadataByMarker = resolveGlobalSingleton(
  Symbol.for("openclaw.beforeToolCallMetadata"),
  () => new WeakMap<object, BeforeToolCallMetadata>(),
);

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

export function bindBeforeToolCallMetadata(
  tool: AnyAgentTool,
  { sourceTool, ...metadata }: BeforeToolCallMetadata & { sourceTool: AnyAgentTool },
): void {
  const marker = Object.freeze({});
  metadataByMarker.set(marker, metadata);
  Object.defineProperties(tool, {
    [BEFORE_TOOL_CALL_WRAPPED]: { value: marker, enumerable: true },
    // Reading through a plugin view retains every outer source-execution guard.
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
export function copyBeforeToolCallMetadata(source: AnyAgentTool, target: AnyAgentTool): void {
  const marker = withBeforeToolCallMetadata(source)[BEFORE_TOOL_CALL_WRAPPED];
  if (!marker || !metadataByMarker.has(marker)) {
    return;
  }
  Object.defineProperty(target, BEFORE_TOOL_CALL_WRAPPED, { value: marker, enumerable: true });
  const sourceTool = getBeforeToolCallSourceTool(source);
  if (sourceTool) {
    Object.defineProperty(target, BEFORE_TOOL_CALL_SOURCE_TOOL, {
      value: sourceTool,
      enumerable: false,
    });
  }
}
