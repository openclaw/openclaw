//#region extensions/telegram/configured-state.d.ts
declare function hasTelegramConfiguredState(params: {
  env?: NodeJS.ProcessEnv;
}): boolean;
//#endregion
export { hasTelegramConfiguredState };