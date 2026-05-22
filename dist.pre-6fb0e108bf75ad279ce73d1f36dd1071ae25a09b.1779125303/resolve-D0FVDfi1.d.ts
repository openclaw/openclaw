import { i as OpenClawConfig } from "./types.openclaw-DBDmmaVM.js";
import { p as SecretRef } from "./types.secrets-CD6lO6cv.js";
import { h as SecretRefResolveCache } from "./runtime-shared-DP7NBiUn.js";

//#region src/secrets/resolve.d.ts
type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};
declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
//#endregion
export { resolveSecretRefValues as t };