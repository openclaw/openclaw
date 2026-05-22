import { type SafeOpenResult } from "../infra/fs-safe.js";
export declare function normalizeUrlPath(rawPath: string): string;
export declare function resolveFileWithinRoot(rootReal: string, urlPath: string): Promise<SafeOpenResult | null>;
