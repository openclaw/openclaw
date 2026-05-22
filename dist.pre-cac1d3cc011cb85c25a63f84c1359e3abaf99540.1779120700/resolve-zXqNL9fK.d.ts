import { i as OpenClawConfig } from "./types.openclaw-C58U02FA.js";
import { p as SecretRef } from "./types.secrets-DGR8Okv9.js";
import { h as SecretRefResolveCache } from "./runtime-shared-DE3187a6.js";

//#region src/secrets/resolve.d.ts
type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};
declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
//#endregion
export { resolveSecretRefValues as t };