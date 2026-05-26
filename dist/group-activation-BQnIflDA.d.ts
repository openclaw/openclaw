//#region src/auto-reply/group-activation.d.ts
type GroupActivationMode = "mention" | "always";
declare function normalizeGroupActivation(raw?: string | null): GroupActivationMode | undefined;
declare function parseActivationCommand(raw?: string): {
  hasCommand: boolean;
  mode?: GroupActivationMode;
};
//#endregion
export { normalizeGroupActivation as n, parseActivationCommand as r, GroupActivationMode as t };