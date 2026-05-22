//#region node_modules/@openclaw/fs-safe/dist/secret-file.d.ts
declare const DEFAULT_SECRET_FILE_MAX_BYTES: number;
declare const PRIVATE_SECRET_DIR_MODE = 448;
declare const PRIVATE_SECRET_FILE_MODE = 384;
type SecretFileReadOptions = {
  maxBytes?: number;
  rejectSymlink?: boolean;
  rejectHardlinks?: boolean;
};
declare function readSecretFileSync(filePath: string, label: string, options?: SecretFileReadOptions): string;
declare function tryReadSecretFileSync(filePath: string | undefined, label: string, options?: SecretFileReadOptions): string | undefined;
declare function writeSecretFileAtomic(params: {
  rootDir: string;
  filePath: string;
  content: string | Uint8Array;
  mode?: number;
  dirMode?: number;
}): Promise<void>;
//#endregion
//#region src/infra/secret-file.d.ts
type SecretFileReadResult = {
  ok: true;
  secret: string;
  resolvedPath: string;
} | {
  ok: false;
  message: string;
  resolvedPath?: string;
  error?: unknown;
};
/** @deprecated Use readSecretFileSync() or tryReadSecretFileSync(). */
declare function loadSecretFileSync(filePath: string, label: string, options?: Parameters<typeof readSecretFileSync>[2]): SecretFileReadResult;
//#endregion
export { PRIVATE_SECRET_FILE_MODE as a, tryReadSecretFileSync as c, PRIVATE_SECRET_DIR_MODE as i, writeSecretFileAtomic as l, loadSecretFileSync as n, SecretFileReadOptions as o, DEFAULT_SECRET_FILE_MAX_BYTES as r, readSecretFileSync as s, SecretFileReadResult as t };