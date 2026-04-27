import type { StreamFn } from "@mariozechner/pi-agent-core";
import { type Api } from "@mariozechner/pi-ai";
export declare function getCustomApiRegistrySourceId(api: Api): string;
export declare function ensureCustomApiRegistered(api: Api, streamFn: StreamFn): boolean;
