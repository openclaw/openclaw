import type { MediaUnderstandingProvider } from "../types.js";
export declare function normalizeMediaProviderId(id: string): string;
export declare function buildMediaUnderstandingRegistry(overrides?: Record<string, MediaUnderstandingProvider>): Map<string, MediaUnderstandingProvider>;
export declare function getMediaUnderstandingProvider(id: string, registry: Map<string, MediaUnderstandingProvider>): MediaUnderstandingProvider | undefined;
