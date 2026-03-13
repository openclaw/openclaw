export type SlashCommandParseResult = {
    kind: "no-match";
} | {
    kind: "empty";
} | {
    kind: "invalid";
} | {
    kind: "parsed";
    action: string;
    args: string;
};
export type ParsedSlashCommand = {
    ok: true;
    action: string;
    args: string;
} | {
    ok: false;
    message: string;
};
export declare function parseSlashCommandActionArgs(raw: string, slash: string): SlashCommandParseResult;
export declare function parseSlashCommandOrNull(raw: string, slash: string, opts: {
    invalidMessage: string;
    defaultAction?: string;
}): ParsedSlashCommand | null;
