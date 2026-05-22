import { i as OpenClawConfig } from "./types.openclaw-C5VNg6h3.js";
import { n as ResolvedConfiguredAcpBinding } from "./persistent-bindings.resolve-CeqRk7iN.js";

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