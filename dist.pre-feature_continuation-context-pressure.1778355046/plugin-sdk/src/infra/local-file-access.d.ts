export declare function hasEncodedFileUrlSeparator(pathname: string): boolean;
export declare function isWindowsNetworkPath(filePath: string): boolean;
export declare function assertNoWindowsNetworkPath(filePath: string, label?: string): void;
export declare function safeFileURLToPath(fileUrl: string): string;
export declare function trySafeFileURLToPath(fileUrl: string): string | undefined;
export declare function basenameFromMediaSource(source?: string): string | undefined;
