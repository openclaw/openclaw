export type GroupActivationMode = "mention" | "always";
export declare function normalizeGroupActivation(raw?: string | null): GroupActivationMode | undefined;
export declare function parseActivationCommand(raw?: string): {
    hasCommand: boolean;
    mode?: GroupActivationMode;
};
