import "./fs-safe-defaults.js";
import { type FileStore, type FileStoreSync } from "@openclaw/fs-safe/store";
export type PrivateFileStore = FileStore;
export declare function privateFileStore(rootDir: string): FileStore;
export type PrivateFileStoreSync = FileStoreSync;
export declare function privateFileStoreSync(rootDir: string): PrivateFileStoreSync;
