import type { StreamFn } from "@earendil-works/pi-agent-core";
export declare function decodeHtmlEntitiesInObject(value: unknown): unknown;
export declare function createHtmlEntityToolCallArgumentDecodingWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
