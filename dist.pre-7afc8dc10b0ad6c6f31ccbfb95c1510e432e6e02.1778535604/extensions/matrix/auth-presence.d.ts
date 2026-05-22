import { i as OpenClawConfig } from "../../types.openclaw-C9E_zZnO.js";
//#region extensions/matrix/auth-presence.d.ts
type MatrixAuthPresenceParams = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
} | OpenClawConfig;
declare function hasAnyMatrixAuth(params: MatrixAuthPresenceParams, env?: NodeJS.ProcessEnv): boolean;
//#endregion
export { hasAnyMatrixAuth };