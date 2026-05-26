//#region src/channels/command-gating.d.ts
type CommandAuthorizer = {
  configured: boolean;
  allowed: boolean;
};
type CommandGatingModeWhenAccessGroupsOff = "allow" | "deny" | "configured";
declare function resolveCommandAuthorizedFromAuthorizers(params: {
  useAccessGroups: boolean;
  authorizers: CommandAuthorizer[];
  modeWhenAccessGroupsOff?: CommandGatingModeWhenAccessGroupsOff;
}): boolean;
declare function resolveControlCommandGate(params: {
  useAccessGroups: boolean;
  authorizers: CommandAuthorizer[];
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  modeWhenAccessGroupsOff?: CommandGatingModeWhenAccessGroupsOff;
}): {
  commandAuthorized: boolean;
  shouldBlock: boolean;
};
declare function resolveDualTextControlCommandGate(params: {
  useAccessGroups: boolean;
  primaryConfigured: boolean;
  primaryAllowed: boolean;
  secondaryConfigured: boolean;
  secondaryAllowed: boolean;
  hasControlCommand: boolean;
  modeWhenAccessGroupsOff?: CommandGatingModeWhenAccessGroupsOff;
}): {
  commandAuthorized: boolean;
  shouldBlock: boolean;
};
//#endregion
export { resolveDualTextControlCommandGate as a, resolveControlCommandGate as i, CommandGatingModeWhenAccessGroupsOff as n, resolveCommandAuthorizedFromAuthorizers as r, CommandAuthorizer as t };