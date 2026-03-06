type PathNode = Record<string, unknown>;
export declare function parseConfigPath(raw: string): {
    ok: boolean;
    path?: string[];
    error?: string;
};
export declare function setConfigValueAtPath(root: PathNode, path: string[], value: unknown): void;
export declare function unsetConfigValueAtPath(root: PathNode, path: string[]): boolean;
export declare function getConfigValueAtPath(root: PathNode, path: string[]): unknown;
export {};
