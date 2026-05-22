import type { ThreadBindingRecord, ThreadBindingTargetKind } from "./thread-bindings.types.js";
export declare function normalizeNonNegativeMs(raw: number): number;
export declare function resolveBindingIdsForTargetSession(params: {
    targetSessionKey: string;
    accountId?: string;
    targetKind?: ThreadBindingTargetKind;
}): string[];
export declare function updateBindingsForTargetSession(ids: string[], update: (existing: ThreadBindingRecord, now: number) => ThreadBindingRecord): ThreadBindingRecord[];
