export type GatewayBindUrlResult = {
    url: string;
    source: "gateway.bind=custom" | "gateway.bind=tailnet" | "gateway.bind=lan";
} | {
    error: string;
} | null;
export declare function resolveGatewayBindUrl(params: {
    bind?: string;
    customBindHost?: string;
    scheme: "ws" | "wss";
    port: number;
    pickTailnetHost: () => string | null;
    pickLanHost: () => string | null;
}): GatewayBindUrlResult;
