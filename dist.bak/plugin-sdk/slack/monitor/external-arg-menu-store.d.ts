export declare const SLACK_EXTERNAL_ARG_MENU_PREFIX = "openclaw_cmdarg_ext:";
export type SlackExternalArgMenuChoice = {
    label: string;
    value: string;
};
export type SlackExternalArgMenuEntry = {
    choices: SlackExternalArgMenuChoice[];
    userId: string;
    expiresAt: number;
};
export declare function createSlackExternalArgMenuStore(): {
    create(params: {
        choices: SlackExternalArgMenuChoice[];
        userId: string;
    }, now?: number): string;
    readToken(raw: unknown): string | undefined;
    get(token: string, now?: number): SlackExternalArgMenuEntry | undefined;
};
