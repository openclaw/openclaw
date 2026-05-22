//#region src/channels/plugins/account-action-gate.d.ts
type ActionGate<T extends Record<string, boolean | undefined>> = (key: keyof T, defaultValue?: boolean) => boolean;
declare function createAccountActionGate<T extends Record<string, boolean | undefined>>(params: {
  baseActions?: T;
  accountActions?: T;
}): ActionGate<T>;
//#endregion
export { createAccountActionGate as t };