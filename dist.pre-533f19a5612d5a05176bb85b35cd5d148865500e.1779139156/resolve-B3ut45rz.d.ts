import { i as OpenClawConfig } from "./types.openclaw-Bpxi7OSY.js";
import { p as SecretRef } from "./types.secrets-CysBXmFu.js";
import { h as SecretRefResolveCache } from "./runtime-shared-D0ayhT7R.js";

//#region src/secrets/resolve.d.ts
type ResolveSecretRefOptions = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
};
declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
//#endregion
export { resolveSecretRefValues as t };