//#region extensions/slack/configured-state.d.ts
declare function hasSlackConfiguredState(params: {
  env?: NodeJS.ProcessEnv;
}): boolean;
//#endregion
export { hasSlackConfiguredState };