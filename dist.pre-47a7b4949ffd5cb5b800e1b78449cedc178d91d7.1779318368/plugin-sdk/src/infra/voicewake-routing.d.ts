type VoiceWakeRouteTarget = {
    mode: "current";
    agentId?: undefined;
    sessionKey?: undefined;
} | {
    agentId: string;
    sessionKey?: undefined;
    mode?: undefined;
} | {
    sessionKey: string;
    agentId?: undefined;
    mode?: undefined;
};
type VoiceWakeRouteRule = {
    trigger: string;
    target: VoiceWakeRouteTarget;
};
export type VoiceWakeRoutingConfig = {
    version: 1;
    defaultTarget: VoiceWakeRouteTarget;
    routes: VoiceWakeRouteRule[];
    updatedAtMs: number;
};
export declare function normalizeVoiceWakeTriggerWord(value: string): string;
export declare function validateVoiceWakeRoutingConfigInput(input: unknown): {
    ok: true;
} | {
    ok: false;
    message: string;
};
export declare function normalizeVoiceWakeRoutingConfig(input: unknown): VoiceWakeRoutingConfig;
export declare function loadVoiceWakeRoutingConfig(baseDir?: string): Promise<VoiceWakeRoutingConfig>;
export declare function setVoiceWakeRoutingConfig(config: unknown, baseDir?: string): Promise<VoiceWakeRoutingConfig>;
type VoiceWakeResolvedRoute = {
    mode: "current";
} | {
    agentId: string;
} | {
    sessionKey: string;
};
export declare function resolveVoiceWakeRouteByTrigger(params: {
    trigger: string | undefined;
    config: VoiceWakeRoutingConfig;
}): VoiceWakeResolvedRoute;
export {};
