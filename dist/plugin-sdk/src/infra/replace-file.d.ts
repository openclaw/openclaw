import "./fs-safe-defaults.js";
import { replaceFileAtomic as replaceFileAtomicBase, type MovePathWithCopyFallbackOptions as BaseMovePathWithCopyFallbackOptions } from "@openclaw/fs-safe/atomic";
export { replaceDirectoryAtomic, replaceFileAtomicSync, type ReplaceDirectoryAtomicOptions, type ReplaceFileAtomicFileSystem, type ReplaceFileAtomicOptions, type ReplaceFileAtomicResult, type ReplaceFileAtomicSyncFileSystem, type ReplaceFileAtomicSyncOptions, } from "@openclaw/fs-safe/atomic";
export declare const replaceFileAtomic: typeof replaceFileAtomicBase;
export type MovePathWithCopyFallbackOptions = BaseMovePathWithCopyFallbackOptions & {
    sourceHardlinks?: "allow" | "reject";
};
export declare function movePathWithCopyFallback(options: MovePathWithCopyFallbackOptions): Promise<void>;
