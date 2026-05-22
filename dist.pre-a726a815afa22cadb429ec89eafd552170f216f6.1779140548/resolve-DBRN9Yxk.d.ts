import { i as OpenClawConfig } from "./types.openclaw-CQzDxdpQ.js";
import { p as SecretRef } from "./types.secrets-xoyOd9x7.js";
import { h as SecretRefResolveCache } from "./runtime-shared-Ckgewnqv.js";

//#region src/secrets/resolve.d.ts
type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};
declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
//#endregion
export { resolveSecretRefValues as t };