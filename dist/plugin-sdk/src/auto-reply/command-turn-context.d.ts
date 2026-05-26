export type CommandTurnKind = "native" | "text-slash" | "normal";
export type CommandTurnSource = "native" | "text" | "message";
type BaseCommandTurnContext = {
    commandName?: string;
    body?: string;
};
export type NativeCommandTurnContext = BaseCommandTurnContext & {
    kind: "native";
    source: "native";
    authorized: boolean;
};
export type TextSlashCommandTurnContext = BaseCommandTurnContext & {
    kind: "text-slash";
    source: "text";
    authorized: boolean;
};
export type NormalCommandTurnContext = BaseCommandTurnContext & {
    kind: "normal";
    source: "message";
    authorized: false;
};
export type CommandTurnContext = NativeCommandTurnContext | TextSlashCommandTurnContext | NormalCommandTurnContext;
export type CommandTurnContextInput = {
    CommandTurn?: unknown;
    CommandSource?: unknown;
    CommandAuthorized?: unknown;
    CommandBody?: unknown;
    BodyForCommands?: unknown;
    RawBody?: unknown;
    Body?: unknown;
};
export declare function commandTurnKindToSource(kind: CommandTurnKind): CommandTurnSource;
export declare function commandTurnSourceToKind(source: CommandTurnSource): CommandTurnKind;
export declare function createCommandTurnContext(source: CommandTurnSource, input: {
    authorized: boolean;
    commandName?: string;
    body?: string;
}): CommandTurnContext;
export declare function resolveCommandTurnContext(input: CommandTurnContextInput): CommandTurnContext;
export declare function isNativeCommandTurn(commandTurn: CommandTurnContext | undefined): boolean;
export declare function isTextSlashCommandTurn(commandTurn: CommandTurnContext | undefined): boolean;
export declare function isAuthorizedTextSlashCommandTurn(commandTurn: CommandTurnContext | undefined): boolean;
export declare function isExplicitCommandTurn(commandTurn: CommandTurnContext | undefined): boolean;
export declare function resolveCommandTurnTargetSessionKey(input: {
    CommandTurn?: CommandTurnContext;
    CommandSource?: unknown;
    CommandAuthorized?: unknown;
    CommandBody?: unknown;
    BodyForCommands?: unknown;
    RawBody?: unknown;
    Body?: unknown;
    CommandTargetSessionKey?: unknown;
}): string | undefined;
export {};
