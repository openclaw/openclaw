export type CommandAuthorizer = {
    configured: boolean;
    allowed: boolean;
};
export type CommandGatingModeWhenAccessGroupsOff = "allow" | "deny" | "configured";
export declare function resolveCommandAuthorizedFromAuthorizers(params: {
    useAccessGroups: boolean;
    authorizers: CommandAuthorizer[];
    modeWhenAccessGroupsOff?: CommandGatingModeWhenAccessGroupsOff;
}): boolean;
export declare function resolveControlCommandGate(params: {
    useAccessGroups: boolean;
    authorizers: CommandAuthorizer[];
    allowTextCommands: boolean;
    hasControlCommand: boolean;
    modeWhenAccessGroupsOff?: CommandGatingModeWhenAccessGroupsOff;
}): {
    commandAuthorized: boolean;
    shouldBlock: boolean;
};
