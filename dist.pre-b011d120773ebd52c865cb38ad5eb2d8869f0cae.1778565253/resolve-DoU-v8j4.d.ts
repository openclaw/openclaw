import { i as OpenClawConfig } from "./types.openclaw-BdZr8Ncl.js";
import { p as SecretRef } from "./types.secrets-CyFEoWhI.js";
import { h as SecretRefResolveCache } from "./runtime-shared-B5ozVS5A.js";

//#region src/secrets/resolve.d.ts
type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};
declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
//#endregion
export { resolveSecretRefValues as t };