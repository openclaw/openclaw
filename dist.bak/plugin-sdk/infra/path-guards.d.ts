export declare function isNodeError(value: unknown): value is NodeJS.ErrnoException;
export declare function hasNodeErrorCode(value: unknown, code: string): boolean;
export declare function isNotFoundPathError(value: unknown): boolean;
export declare function isSymlinkOpenError(value: unknown): boolean;
export declare function isPathInside(root: string, target: string): boolean;
