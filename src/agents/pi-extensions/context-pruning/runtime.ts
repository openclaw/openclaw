import type { ContextLifecycleEmitter } from "../../context-lifecycle/emitter.js";
import type { EffectiveContextPruningSettings } from "./settings.js";
import { createSessionManagerRuntimeRegistry } from "../session-manager-runtime-registry.js";

export type ContextPruningRuntimeValue = {
  settings: EffectiveContextPruningSettings;
  contextWindowTokens?: number | null;
  isToolPrunable: (toolName: string) => boolean;
  lastCacheTouchAt?: number | null;
  lifecycleEmitter?: ContextLifecycleEmitter;
};

// Important: this relies on Pi passing the same SessionManager object instance into
// ExtensionContext (ctx.sessionManager) that we used when calling setContextPruningRuntime.
const registry = createSessionManagerRuntimeRegistry<ContextPruningRuntimeValue>();

export const setContextPruningRuntime = registry.set;

export const getContextPruningRuntime = registry.get;
