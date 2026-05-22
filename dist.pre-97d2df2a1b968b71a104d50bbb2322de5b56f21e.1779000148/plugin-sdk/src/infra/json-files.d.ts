import "./fs-safe-defaults.js";
export { JsonFileReadError, readJson, readJson as readJsonFileStrict, readJsonIfExists, readJsonIfExists as readDurableJsonFile, readJsonSync, readRootJsonObjectSync, readRootJsonSync, readRootStructuredFileSync, tryReadJson, tryReadJson as readJsonFile, tryReadJsonSync, tryReadJsonSync as readJsonFileSync, writeJson, writeJson as writeJsonAtomic, writeJsonSync, } from "@openclaw/fs-safe/json";
export { createAsyncLock } from "@openclaw/fs-safe/advanced";
export type WriteTextAtomicOptions = {
    mode?: number;
    dirMode?: number;
    trailingNewline?: boolean;
    durable?: boolean;
};
export declare function writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void>;
