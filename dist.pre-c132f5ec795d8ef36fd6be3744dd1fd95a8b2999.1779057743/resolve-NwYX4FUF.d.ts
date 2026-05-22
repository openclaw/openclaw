import { i as OpenClawConfig } from "./types.openclaw-BMMD0Ykw.js";
import { p as SecretRef } from "./types.secrets-B6u_z8uk.js";
import { h as SecretRefResolveCache } from "./runtime-shared-B4WVL4ED.js";

//#region src/secrets/resolve.d.ts
type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};
declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
//#endregion
export { resolveSecretRefValues as t };