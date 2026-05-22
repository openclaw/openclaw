import { i as OpenClawConfig } from "./types.openclaw-BorXMoYB.js";
import { p as SecretRef } from "./types.secrets-tbFW-hY6.js";
import { h as SecretRefResolveCache } from "./runtime-shared-fN4ELLcc.js";

//#region src/secrets/resolve.d.ts
type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};
declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
//#endregion
export { resolveSecretRefValues as t };