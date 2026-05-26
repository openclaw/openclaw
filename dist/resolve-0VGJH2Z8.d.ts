import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { p as SecretRef } from "./types.secrets-n2DWfQVx.js";
import { h as SecretRefResolveCache } from "./runtime-shared-B_VSuJN2.js";

//#region src/secrets/resolve.d.ts
type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};
declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
//#endregion
export { resolveSecretRefValues as t };