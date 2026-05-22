export declare function isGatewayDistEntrypointPath(inputPath: string): boolean;
export declare function buildGatewayInstallEntrypointCandidates(root?: string): string[];
export declare function buildGatewayDistEntrypointCandidates(...inputs: string[]): string[];
export declare function findFirstAccessibleGatewayEntrypoint(candidates: string[], exists?: (candidate: string) => Promise<boolean>): Promise<string | undefined>;
export declare function resolveGatewayInstallEntrypoint(root: string | undefined, exists?: (candidate: string) => Promise<boolean>): Promise<string | undefined>;
