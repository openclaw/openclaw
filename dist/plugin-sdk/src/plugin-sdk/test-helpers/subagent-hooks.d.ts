export declare function registerHookHandlersForTest<TApi>(params: {
    config: Record<string, unknown>;
    register: (api: TApi) => void;
}): Map<string, (event: unknown, ctx: unknown) => unknown>;
export declare function getRequiredHookHandler(handlers: Map<string, (event: unknown, ctx: unknown) => unknown>, hookName: string): (event: unknown, ctx: unknown) => unknown;
