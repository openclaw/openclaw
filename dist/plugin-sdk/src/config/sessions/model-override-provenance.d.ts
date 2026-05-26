import type { SessionEntry } from "./types.js";
export declare function hasSessionAutoModelFallbackProvenance(entry: Pick<SessionEntry, "providerOverride" | "modelOverride" | "modelOverrideFallbackOriginProvider" | "modelOverrideFallbackOriginModel"> | undefined): boolean;
