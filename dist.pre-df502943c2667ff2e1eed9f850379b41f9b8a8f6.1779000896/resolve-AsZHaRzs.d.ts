import { i as OpenClawConfig } from "./types.openclaw-D8bJSZjd.js";
import { p as SecretRef } from "./types.secrets-Cv8UO7TK.js";
import { h as SecretRefResolveCache } from "./runtime-shared-BXbA4I1X.js";

//#region src/secrets/resolve.d.ts
type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};
declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
//#endregion
export { resolveSecretRefValues as t };