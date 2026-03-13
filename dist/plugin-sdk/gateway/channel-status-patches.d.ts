export type ConnectedChannelStatusPatch = {
    connected: true;
    lastConnectedAt: number;
    lastEventAt: number;
};
export declare function createConnectedChannelStatusPatch(at?: number): ConnectedChannelStatusPatch;
