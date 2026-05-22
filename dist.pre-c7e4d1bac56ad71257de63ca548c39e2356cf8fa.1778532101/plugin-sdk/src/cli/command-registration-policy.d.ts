export declare function isReservedNonPluginCommandRoot(primary: string | null | undefined): boolean;
export declare function shouldRegisterPrimaryCommandOnly(argv: string[]): boolean;
export declare function shouldSkipPluginCommandRegistration(params: {
    argv: string[];
    primary: string | null;
    hasBuiltinPrimary: boolean;
}): boolean;
export declare function shouldEagerRegisterSubcommands(env?: NodeJS.ProcessEnv): boolean;
export declare function shouldRegisterPrimarySubcommandOnly(argv: string[], env?: NodeJS.ProcessEnv): boolean;
