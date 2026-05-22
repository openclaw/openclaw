import { i as OpenClawConfig } from "./types.openclaw-DZQrhn8E.js";
import { p as SecretRef } from "./types.secrets-B8pKm5jY.js";
import { h as SecretRefResolveCache } from "./runtime-shared-C-_wyf1C.js";

//#region src/secrets/resolve.d.ts
type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};
declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
//#endregion
export { resolveSecretRefValues as t };