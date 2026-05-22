import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelProviderLocalServiceConfig } from "../config/types.models.js";
export type ProviderLocalServiceLease = {
    release: () => void;
};
export declare function attachModelProviderLocalService<TModel extends object>(model: TModel, service: ModelProviderLocalServiceConfig | undefined): TModel;
export declare function getModelProviderLocalService(model: object): ModelProviderLocalServiceConfig | undefined;
export declare function ensureModelProviderLocalService(model: Model<Api>, probeHeaders?: HeadersInit, signal?: AbortSignal | null): Promise<ProviderLocalServiceLease | undefined>;
export declare function stopManagedProviderLocalServicesForTest(): void;
