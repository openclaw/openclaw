import { createSessionManagerRuntimeRegistry } from "../session-manager-runtime-registry.js";
// Important: this relies on Pi passing the same SessionManager object instance into
// ExtensionContext (ctx.sessionManager) that we used when calling setContextPruningRuntime.
const registry = createSessionManagerRuntimeRegistry();
export const setContextPruningRuntime = registry.set;
export const getContextPruningRuntime = registry.get;
