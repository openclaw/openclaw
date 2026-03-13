import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedTalkConfig, TalkConfig, TalkConfigResponse } from "./types.gateway.js";
import type { OpenClawConfig } from "./types.js";
type TalkApiKeyDeps = {
    fs?: typeof fs;
    os?: typeof os;
    path?: typeof path;
};
export declare const DEFAULT_TALK_PROVIDER = "elevenlabs";
export declare function normalizeTalkSection(value: TalkConfig | undefined): TalkConfig | undefined;
export declare function normalizeTalkConfig(config: OpenClawConfig): OpenClawConfig;
export declare function resolveActiveTalkProviderConfig(talk: TalkConfig | undefined): ResolvedTalkConfig | undefined;
export declare function buildTalkConfigResponse(value: unknown): TalkConfigResponse | undefined;
export declare function readTalkApiKeyFromProfile(deps?: TalkApiKeyDeps): string | null;
export declare function resolveTalkApiKey(env?: NodeJS.ProcessEnv, deps?: TalkApiKeyDeps): string | null;
export {};
