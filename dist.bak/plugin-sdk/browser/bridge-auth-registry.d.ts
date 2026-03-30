type BridgeAuth = {
    token?: string;
    password?: string;
};
export declare function setBridgeAuthForPort(port: number, auth: BridgeAuth): void;
export declare function getBridgeAuthForPort(port: number): BridgeAuth | undefined;
export declare function deleteBridgeAuthForPort(port: number): void;
export {};
