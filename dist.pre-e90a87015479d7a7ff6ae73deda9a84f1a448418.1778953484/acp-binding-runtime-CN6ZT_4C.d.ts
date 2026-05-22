import { i as OpenClawConfig } from "./types.openclaw-DNoZmPZ8.js";
import { n as ResolvedConfiguredAcpBinding } from "./persistent-bindings.resolve-CrOj0dl1.js";

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