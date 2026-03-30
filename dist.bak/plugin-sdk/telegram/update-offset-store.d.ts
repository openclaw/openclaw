export declare function readTelegramUpdateOffset(params: {
    accountId?: string;
    botToken?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<number | null>;
export declare function writeTelegramUpdateOffset(params: {
    accountId?: string;
    updateId: number;
    botToken?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<void>;
export declare function deleteTelegramUpdateOffset(params: {
    accountId?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<void>;
