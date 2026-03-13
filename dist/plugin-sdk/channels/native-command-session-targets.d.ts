export type ResolveNativeCommandSessionTargetsParams = {
    agentId: string;
    sessionPrefix: string;
    userId: string;
    targetSessionKey: string;
    boundSessionKey?: string;
    lowercaseSessionKey?: boolean;
};
export declare function resolveNativeCommandSessionTargets(params: ResolveNativeCommandSessionTargetsParams): {
    sessionKey: string;
    commandTargetSessionKey: string;
};
