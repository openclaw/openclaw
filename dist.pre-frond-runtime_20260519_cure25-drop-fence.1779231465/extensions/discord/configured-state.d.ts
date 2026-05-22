//#region extensions/discord/configured-state.d.ts
declare function hasDiscordConfiguredState(params: {
  env?: NodeJS.ProcessEnv;
}): boolean;
//#endregion
export { hasDiscordConfiguredState };