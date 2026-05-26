export type ConnectedChannelStatusPatch = {
    connected: true;
    lastConnectedAt: number;
    lastEventAt: number;
};
export type TransportActivityChannelStatusPatch = {
    lastTransportActivityAt: number;
};
export declare function createConnectedChannelStatusPatch(at?: number): ConnectedChannelStatusPatch;
export declare function createTransportActivityStatusPatch(at?: number): TransportActivityChannelStatusPatch;
