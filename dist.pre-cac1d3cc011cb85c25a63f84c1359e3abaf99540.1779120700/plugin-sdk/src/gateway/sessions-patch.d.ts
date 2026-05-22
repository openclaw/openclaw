import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ErrorShape, type SessionsPatchParams } from "./protocol/index.js";
export declare function applySessionsPatchToStore(params: {
    cfg: OpenClawConfig;
    store: Record<string, SessionEntry>;
    storeKey: string;
    patch: SessionsPatchParams;
    loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
}): Promise<{
    ok: true;
    entry: SessionEntry;
} | {
    ok: false;
    error: ErrorShape;
}>;
