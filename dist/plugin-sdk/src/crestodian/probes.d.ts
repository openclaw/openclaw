export type LocalCommandProbe = {
    command: string;
    found: boolean;
    version?: string;
    error?: string;
};
export declare function probeLocalCommand(command: string, args?: string[], opts?: {
    timeoutMs?: number;
}): Promise<LocalCommandProbe>;
export declare function probeGatewayUrl(url: string, opts?: {
    timeoutMs?: number;
}): Promise<{
    reachable: boolean;
    url: string;
    error?: string;
}>;
