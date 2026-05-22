export declare const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";
export declare const OPENCLAW_CLI_ENV_VALUE = "1";
export declare function markOpenClawExecEnv<T extends Record<string, string | undefined>>(env: T): T;
export declare function ensureOpenClawExecMarkerOnProcess(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
