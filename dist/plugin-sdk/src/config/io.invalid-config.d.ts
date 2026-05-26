type ConfigValidationIssueLike = {
    path: string;
    message: string;
};
export declare function formatInvalidConfigDetails(issues: ConfigValidationIssueLike[]): string;
export declare function formatInvalidConfigLogMessage(configPath: string, details: string): string;
export declare function logInvalidConfigOnce(params: {
    configPath: string;
    details: string;
    logger: Pick<typeof console, "error">;
    loggedConfigPaths: Set<string>;
}): void;
export declare function createInvalidConfigError(configPath: string, details: string): Error;
export declare function throwInvalidConfig(params: {
    configPath: string;
    issues: ConfigValidationIssueLike[];
    logger: Pick<typeof console, "error">;
    loggedConfigPaths: Set<string>;
}): never;
export {};
