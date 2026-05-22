import { i as OpenClawConfig } from "./types.openclaw-C5VNg6h3.js";
import { o as SessionEntry } from "./types-5yIklHT9.js";

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