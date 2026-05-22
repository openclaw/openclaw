import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { o as SessionEntry } from "./types-Choy2DhC.js";

//#region src/config/sessions/combined-store-gateway.d.ts
declare function loadCombinedSessionStoreForGateway(cfg: OpenClawConfig, opts?: {
  agentId?: string;
}): {
  storePath: string;
  store: Record<string, SessionEntry>;
};
//#endregion
export { loadCombinedSessionStoreForGateway as t };