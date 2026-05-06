import { vi } from "vitest";

const runtimeApiMockState = vi.hoisted(() => ({
  dispatchReplyFromConfigWithSettledDispatcher: vi.fn(async (params: { ctxPayload: unknown }) => ({
    queuedFinal: false,
    counts: {},
    capturedCtxPayload: params.ctxPayload,
  })),
  hasFinalInboundReplyDispatch: vi.fn(() => false),
  resolveInboundReplyDispatchCounts: vi.fn(() => ({ final: 0 })),
}));

export function getRuntimeApiMockState() {
  return runtimeApiMockState;
}

vi.mock("openclaw/plugin-sdk/inbound-reply-dispatch", () => {
  return {
    dispatchReplyFromConfigWithSettledDispatcher:
      runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher,
    hasFinalInboundReplyDispatch: runtimeApiMockState.hasFinalInboundReplyDispatch,
    resolveInboundReplyDispatchCounts: runtimeApiMockState.resolveInboundReplyDispatchCounts,
  };
});

vi.mock("../reply-dispatcher.js", () => ({
  createMSTeamsReplyDispatcher: () => ({
    dispatcher: {},
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  }),
}));
