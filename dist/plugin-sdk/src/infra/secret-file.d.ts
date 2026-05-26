import "./fs-safe-defaults.js";
import { readSecretFileSync as readSecretFileSyncImpl } from "@openclaw/fs-safe/secret";
export { DEFAULT_SECRET_FILE_MAX_BYTES, PRIVATE_SECRET_DIR_MODE, PRIVATE_SECRET_FILE_MODE, readSecretFileSync, tryReadSecretFileSync, type SecretFileReadOptions, } from "@openclaw/fs-safe/secret";
export { writeSecretFileAtomic as writePrivateSecretFileAtomic } from "@openclaw/fs-safe/secret";
export type SecretFileReadResult = {
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
export declare function loadSecretFileSync(filePath: string, label: string, options?: Parameters<typeof readSecretFileSyncImpl>[2]): SecretFileReadResult;
