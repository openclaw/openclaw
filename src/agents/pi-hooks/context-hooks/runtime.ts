import type { HookRunner } from "../../../plugins/hooks.js";
import type { PluginHookAgentContext } from "../../../plugins/types.js";
import { createSessionManagerRuntimeRegistry } from "../session-manager-runtime-registry.js";

export type ContextHooksRuntimeValue = {
  hookRunner: HookRunner;
  hookCtx: PluginHookAgentContext;
  modelId: string;
  provider: string;
  contextWindowTokens: number;
};

const registry = createSessionManagerRuntimeRegistry<ContextHooksRuntimeValue>();

export const setContextHooksRuntime = registry.set;

export const getContextHooksRuntime = registry.get;
