import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { n as ResolvedConfiguredAcpBinding } from "./persistent-bindings.resolve-C7e2_Xvm.js";

//#region src/acp/persistent-bindings.lifecycle.d.ts
declare function ensureConfiguredAcpBindingReady(params: {
  cfg: OpenClawConfig;
  configuredBinding: ResolvedConfiguredAcpBinding | null;
}): Promise<{
  ok: true;
} | {
  ok: false;
  error: string;
}>;
//#endregion
export { ensureConfiguredAcpBindingReady as t };