type RouteLike = {
    agentId: string;
    sessionKey: string;
};
type RoutePeerLike = {
    kind: string;
    id: string | number;
};
type InboundEnvelopeFormatParams<TEnvelope> = {
    channel: string;
    from: string;
    timestamp?: number;
    previousTimestamp?: number;
    envelope: TEnvelope;
    body: string;
};
type InboundRouteResolveParams<TConfig, TPeer extends RoutePeerLike> = {
    cfg: TConfig;
    channel: string;
    accountId: string;
    peer: TPeer;
};
export declare function createInboundEnvelopeBuilder<TConfig, TEnvelope>(params: {
    cfg: TConfig;
    route: RouteLike;
    sessionStore?: string;
    resolveStorePath: (store: string | undefined, opts: {
        agentId: string;
    }) => string;
    readSessionUpdatedAt: (params: {
        storePath: string;
        sessionKey: string;
    }) => number | undefined;
    resolveEnvelopeFormatOptions: (cfg: TConfig) => TEnvelope;
    formatAgentEnvelope: (params: InboundEnvelopeFormatParams<TEnvelope>) => string;
}): (input: {
    channel: string;
    from: string;
    body: string;
    timestamp?: number;
}) => {
    storePath: string;
    body: string;
};
export declare function resolveInboundRouteEnvelopeBuilder<TConfig, TEnvelope, TRoute extends RouteLike, TPeer extends RoutePeerLike>(params: {
    cfg: TConfig;
    channel: string;
    accountId: string;
    peer: TPeer;
    resolveAgentRoute: (params: InboundRouteResolveParams<TConfig, TPeer>) => TRoute;
    sessionStore?: string;
    resolveStorePath: (store: string | undefined, opts: {
        agentId: string;
    }) => string;
    readSessionUpdatedAt: (params: {
        storePath: string;
        sessionKey: string;
    }) => number | undefined;
    resolveEnvelopeFormatOptions: (cfg: TConfig) => TEnvelope;
    formatAgentEnvelope: (params: InboundEnvelopeFormatParams<TEnvelope>) => string;
}): {
    route: TRoute;
    buildEnvelope: ReturnType<typeof createInboundEnvelopeBuilder<TConfig, TEnvelope>>;
};
type InboundRouteEnvelopeRuntime<TConfig, TEnvelope, TRoute extends RouteLike, TPeer extends RoutePeerLike> = {
    routing: {
        resolveAgentRoute: (params: InboundRouteResolveParams<TConfig, TPeer>) => TRoute;
    };
    session: {
        resolveStorePath: (store: string | undefined, opts: {
            agentId: string;
        }) => string;
        readSessionUpdatedAt: (params: {
            storePath: string;
            sessionKey: string;
        }) => number | undefined;
    };
    reply: {
        resolveEnvelopeFormatOptions: (cfg: TConfig) => TEnvelope;
        formatAgentEnvelope: (params: InboundEnvelopeFormatParams<TEnvelope>) => string;
    };
};
export declare function resolveInboundRouteEnvelopeBuilderWithRuntime<TConfig, TEnvelope, TRoute extends RouteLike, TPeer extends RoutePeerLike>(params: {
    cfg: TConfig;
    channel: string;
    accountId: string;
    peer: TPeer;
    runtime: InboundRouteEnvelopeRuntime<TConfig, TEnvelope, TRoute, TPeer>;
    sessionStore?: string;
}): {
    route: TRoute;
    buildEnvelope: ReturnType<typeof createInboundEnvelopeBuilder<TConfig, TEnvelope>>;
};
export {};
