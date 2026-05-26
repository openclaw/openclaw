import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { o as SessionEntry } from "./types-D2DuU_TB.js";

//#region src/config/sessions/combined-store-gateway.d.ts
declare function loadCombinedSessionStoreForGateway(cfg: OpenClawConfig, opts?: {
  agentId?: string;
  configuredAgentsOnly?: boolean;
}): {
  storePath: string;
  store: Record<string, SessionEntry>;
};
//#endregion
export { loadCombinedSessionStoreForGateway as t };