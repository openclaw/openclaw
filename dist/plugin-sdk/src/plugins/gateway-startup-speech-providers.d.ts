import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function normalizeConfiguredSpeechProviderIdForStartup(value: unknown): string | undefined;
export declare function collectConfiguredSpeechProviderIds(config: OpenClawConfig): ReadonlySet<string>;
