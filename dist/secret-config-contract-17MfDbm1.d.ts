import { r as SecretDefaults, t as ResolverContext } from "./runtime-shared-B_VSuJN2.js";
import { o as SecretTargetRegistryEntry } from "./target-registry-types-CgO3NGu8.js";
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