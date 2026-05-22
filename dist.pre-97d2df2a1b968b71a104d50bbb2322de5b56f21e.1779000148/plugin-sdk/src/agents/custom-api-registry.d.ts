import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type Api } from "@earendil-works/pi-ai";
export declare function getCustomApiRegistrySourceId(api: Api): string;
export declare function ensureCustomApiRegistered(api: Api, streamFn: StreamFn): boolean;
