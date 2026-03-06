export type TailscaleStatusCommandResult = {
    code: number | null;
    stdout: string;
};
export type TailscaleStatusCommandRunner = (argv: string[], opts: {
    timeoutMs: number;
}) => Promise<TailscaleStatusCommandResult>;
export declare function resolveTailnetHostWithRunner(runCommandWithTimeout?: TailscaleStatusCommandRunner): Promise<string | null>;
