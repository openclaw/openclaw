import "./fs-safe-defaults.js";
import { tryReadJsonSync, tryReadJson, writeJsonSync } from "@openclaw/fs-safe/json";
export { tryReadJson, tryReadJsonSync, writeJsonSync };
export declare const readJsonFile: typeof tryReadJson;
export declare function saveJsonFile(pathname: string, data: unknown): void;
export declare function loadJsonFile<T = unknown>(pathname: string): T | undefined;
