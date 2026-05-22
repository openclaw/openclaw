import { i as OpenClawConfig } from "./types.openclaw-C5VNg6h3.js";
import { p as SecretRef } from "./types.secrets-BK49B9sN.js";
import { h as SecretRefResolveCache } from "./runtime-shared-MszpPUPY.js";

//#region src/secrets/resolve.d.ts
type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};
declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
//#endregion
export { resolveSecretRefValues as t };