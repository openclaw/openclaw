type NodeOnlyServiceLike = {
    installed: boolean | null;
    loaded?: boolean | null;
    externallyManaged?: boolean;
    runtime?: {
        status?: string;
        pid?: number;
    } | undefined;
    runtimeShort?: string | null;
};
export type NodeOnlyGatewayInfo = {
    gatewayTarget: string;
    gatewayValue: string;
    connectionDetails: string;
};
export declare function resolveNodeOnlyGatewayInfo(params: {
    daemon: Pick<NodeOnlyServiceLike, "installed">;
    node: NodeOnlyServiceLike;
}): Promise<NodeOnlyGatewayInfo | null>;
export {};
