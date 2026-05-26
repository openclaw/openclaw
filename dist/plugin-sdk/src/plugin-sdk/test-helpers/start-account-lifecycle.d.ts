import { vi } from "vitest";
import type { ChannelAccountSnapshot, ChannelGatewayContext } from "../testing.js";
export declare function startAccountAndTrackLifecycle<TAccount extends {
    accountId: string;
}>(params: {
    startAccount: (ctx: ChannelGatewayContext<TAccount>) => Promise<unknown>;
    account: TAccount;
}): {
    abort: AbortController;
    patches: ChannelAccountSnapshot[];
    task: Promise<unknown>;
    isSettled: () => boolean;
};
export declare function abortStartedAccount(params: {
    abort: AbortController;
    task: Promise<unknown>;
}): Promise<void>;
export declare function waitForStartedMocks(...mocks: Array<ReturnType<typeof vi.fn>>): () => Promise<void>;
export declare function expectLifecyclePatch(patches: ChannelAccountSnapshot[], expected: Partial<ChannelAccountSnapshot>): void;
export declare function expectPendingUntilAbort(params: {
    waitForStarted: () => Promise<void>;
    isSettled: () => boolean;
    abort: AbortController;
    task: Promise<unknown>;
    assertBeforeAbort?: () => void;
    assertAfterAbort?: () => void;
}): Promise<void>;
export declare function expectStopPendingUntilAbort(params: {
    waitForStarted: () => Promise<void>;
    isSettled: () => boolean;
    abort: AbortController;
    task: Promise<unknown>;
    stop: ReturnType<typeof vi.fn>;
}): Promise<void>;
