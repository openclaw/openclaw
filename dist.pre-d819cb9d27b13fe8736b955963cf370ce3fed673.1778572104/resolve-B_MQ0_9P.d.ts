import { i as OpenClawConfig } from "./types.openclaw-BlE9q7jU.js";
import { p as SecretRef } from "./types.secrets-Cn9M0bVK.js";
import { h as SecretRefResolveCache } from "./runtime-shared-DOi_eoo8.js";

//#region src/secrets/resolve.d.ts
type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};
declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
//#endregion
export { resolveSecretRefValues as t };