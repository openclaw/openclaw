import { r as SecretDefaults, t as ResolverContext } from "./runtime-shared-Cnf43Bx7.js";
import { o as SecretTargetRegistryEntry } from "./target-registry-types-B5UZsM0q.js";
//#region extensions/discord/src/secret-config-contract.d.ts
declare const secretTargetRegistryEntries: SecretTargetRegistryEntry[];
declare function collectRuntimeConfigAssignments(params: {
  config: {
    channels?: Record<string, unknown>;
  };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void;
//#endregion
export { secretTargetRegistryEntries as n, collectRuntimeConfigAssignments as t };