export declare function buildDispatchInboundCaptureMock<T extends Record<string, unknown>>(actual: T, setCtx: (ctx: unknown) => void): T & {
    dispatchInboundMessage: import("vitest").Mock<(params: {
        ctx: unknown;
    }) => Promise<{
        queuedFinal: boolean;
        counts: {
            tool: number;
            block: number;
            final: number;
        };
    }>>;
    dispatchInboundMessageWithDispatcher: import("vitest").Mock<(params: {
        ctx: unknown;
    }) => Promise<{
        queuedFinal: boolean;
        counts: {
            tool: number;
            block: number;
            final: number;
        };
    }>>;
    dispatchInboundMessageWithBufferedDispatcher: import("vitest").Mock<(params: {
        ctx: unknown;
    }) => Promise<{
        queuedFinal: boolean;
        counts: {
            tool: number;
            block: number;
            final: number;
        };
    }>>;
};
