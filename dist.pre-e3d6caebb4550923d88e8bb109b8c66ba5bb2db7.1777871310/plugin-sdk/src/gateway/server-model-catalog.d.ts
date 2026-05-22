import { getRuntimeConfig } from "../config/io.js";
export type GatewayModelChoice = import("../agents/model-catalog.js").ModelCatalogEntry;
type GatewayModelCatalogConfig = ReturnType<typeof getRuntimeConfig>;
type LoadModelCatalog = (params: {
    config: GatewayModelCatalogConfig;
}) => Promise<GatewayModelChoice[]>;
type LoadGatewayModelCatalogParams = {
    getConfig?: () => GatewayModelCatalogConfig;
    loadModelCatalog?: LoadModelCatalog;
};
export declare function markGatewayModelCatalogStaleForReload(): void;
export declare function __resetModelCatalogCacheForTest(): Promise<void>;
export declare function loadGatewayModelCatalog(params?: LoadGatewayModelCatalogParams): Promise<GatewayModelChoice[]>;
export {};
