import type { Stats } from "node:fs";
export type RegularFileStatResult = {
    missing: true;
} | {
    missing: false;
    stat: Stats;
};
export declare function isFileMissingError(err: unknown): err is NodeJS.ErrnoException & {
    code: "ENOENT";
};
export declare function statRegularFile(absPath: string): Promise<RegularFileStatResult>;
