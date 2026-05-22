import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { o as SessionEntry } from "./types-BoPp7-Sf.js";

//#region src/config/sessions/combined-store-gateway.d.ts
declare function loadCombinedSessionStoreForGateway(cfg: OpenClawConfig, opts?: {
  agentId?: string;
}): {
  storePath: string;
  store: Record<string, SessionEntry>;
};
//#endregion
export { loadCombinedSessionStoreForGateway as t };