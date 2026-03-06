import fs from "node:fs";
export declare function isPathInside(baseDir: string, targetPath: string): boolean;
export declare function safeRealpathSync(targetPath: string, cache?: Map<string, string>): string | null;
export declare function safeStatSync(targetPath: string): fs.Stats | null;
export declare function formatPosixMode(mode: number): string;
