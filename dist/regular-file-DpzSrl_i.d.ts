import fs, { Stats } from "node:fs";

//#region node_modules/@openclaw/fs-safe/dist/regular-file.d.ts
type RegularFileStatResult = {
  missing: true;
} | {
  missing: false;
  stat: Stats;
};
type RegularFileAppendFlagConstants = Pick<typeof fs.constants, "O_APPEND" | "O_CREAT" | "O_WRONLY"> & Partial<Pick<typeof fs.constants, "O_NOFOLLOW">>;
type AppendRegularFileOptions = {
  filePath: string;
  content: string | Uint8Array;
  encoding?: BufferEncoding;
  maxFileBytes?: number;
  mode?: number;
  rejectSymlinkParents?: boolean;
};
declare function resolveRegularFileAppendFlags(constants?: RegularFileAppendFlagConstants): number;
declare function statRegularFile(filePath: string): Promise<RegularFileStatResult>;
declare function statRegularFileSync(filePath: string): RegularFileStatResult;
declare function readRegularFile(params: {
  filePath: string;
  maxBytes?: number;
}): Promise<{
  buffer: Buffer;
  stat: Stats;
}>;
declare function readRegularFileSync(params: {
  filePath: string;
  maxBytes?: number;
}): {
  buffer: Buffer;
  stat: Stats;
};
declare function appendRegularFile(options: AppendRegularFileOptions): Promise<void>;
declare function appendRegularFileSync(options: AppendRegularFileOptions): void;
//#endregion
export { resolveRegularFileAppendFlags as a, readRegularFileSync as i, appendRegularFileSync as n, statRegularFile as o, readRegularFile as r, statRegularFileSync as s, appendRegularFile as t };