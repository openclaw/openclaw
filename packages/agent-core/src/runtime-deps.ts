import type { CompleteSimpleFn, StreamFn, Tool, ToolCall, ValidateToolArgumentsFn } from "./llm.js";

export interface AgentCoreRuntimeDeps {
  streamSimple?: StreamFn;
  completeSimple?: CompleteSimpleFn;
  validateToolArguments?: ValidateToolArgumentsFn;
}

const runtimeDeps: AgentCoreRuntimeDeps = {};

export function configureAgentCoreRuntime(deps: AgentCoreRuntimeDeps): void {
  Object.assign(runtimeDeps, deps);
}

function missingRuntimeDep(name: keyof AgentCoreRuntimeDeps): Error {
  return new Error(
    `@openclaw/agent-core runtime dependency "${name}" is not configured. Import OpenClaw's agent runtime facade or pass the dependency explicitly.`,
  );
}

export function resolveAgentCoreStreamFn(streamFn?: StreamFn): StreamFn {
  if (streamFn) {
    return streamFn;
  }
  if (runtimeDeps.streamSimple) {
    return runtimeDeps.streamSimple;
  }
  throw missingRuntimeDep("streamSimple");
}

export function resolveAgentCoreCompleteFn(): CompleteSimpleFn {
  if (runtimeDeps.completeSimple) {
    return runtimeDeps.completeSimple;
  }
  throw missingRuntimeDep("completeSimple");
}

export function validateAgentCoreToolArguments(tool: Tool, toolCall: ToolCall): unknown {
  if (runtimeDeps.validateToolArguments) {
    return runtimeDeps.validateToolArguments(tool, toolCall);
  }
  throw missingRuntimeDep("validateToolArguments");
}
