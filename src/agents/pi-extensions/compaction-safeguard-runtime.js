import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";
const registry = createSessionManagerRuntimeRegistry();
export const setCompactionSafeguardRuntime = registry.set;
export const getCompactionSafeguardRuntime = registry.get;
