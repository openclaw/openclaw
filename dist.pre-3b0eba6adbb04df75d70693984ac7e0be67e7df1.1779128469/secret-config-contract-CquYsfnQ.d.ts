import { r as SecretDefaults, t as ResolverContext } from "./runtime-shared-C-_wyf1C.js";
import { o as SecretTargetRegistryEntry } from "./target-registry-types-Bhh7ys0x.js";
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