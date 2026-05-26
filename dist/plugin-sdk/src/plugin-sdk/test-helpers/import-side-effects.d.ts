export declare function assertNoImportTimeSideEffects(params: {
    moduleId: string;
    forbiddenSeam: string;
    calls: readonly (readonly unknown[])[];
    why: string;
    fixHint: string;
}): void;
