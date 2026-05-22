import { i as OpenClawConfig } from "./types.openclaw-DPnlcagS.js";
import { p as SecretRef } from "./types.secrets-CW3w8nVu.js";
import { h as SecretRefResolveCache } from "./runtime-shared-DldgnHMo.js";

//#region src/secrets/resolve.d.ts
type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};
declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
//#endregion
export { resolveSecretRefValues as t };