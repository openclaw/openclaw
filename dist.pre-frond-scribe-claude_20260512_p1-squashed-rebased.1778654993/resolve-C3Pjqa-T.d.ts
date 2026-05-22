import { i as OpenClawConfig } from "./types.openclaw-BdSNxnBz.js";
import { p as SecretRef } from "./types.secrets-w53yq22b.js";
import { h as SecretRefResolveCache } from "./runtime-shared-BI-sYmF1.js";

//#region src/secrets/resolve.d.ts
type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};
declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
//#endregion
export { resolveSecretRefValues as t };