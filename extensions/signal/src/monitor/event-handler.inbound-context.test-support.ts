import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { Mock } from "vitest";
import type { TestDispatchResult } from "./event-handler.test-harness.js";

export type DispatchInboundMessageMockParams = {
  ctx: MsgContext;
  cfg?: OpenClawConfig;
  dispatcher?: {
    sendFinalReply: (payload: { text: string; isError?: boolean }) => void;
    markComplete: () => void;
    waitForIdle: () => Promise<void>;
  };
  replyOptions?: {
    allowProgressCallbacksWhenSourceDeliverySuppressed?: boolean;
    allowToolLifecycleWhenProgressHidden?: boolean;
    onReplyStart?: () => void | Promise<void>;
    onToolStart?: (payload: { name?: string }) => boolean | void | Promise<boolean | void>;
    onCompactionStart?: () => boolean | void | Promise<boolean | void>;
    onCompactionEnd?: () => boolean | void | Promise<boolean | void>;
  };
};

export function captureNextSignalDispatch(
  mock: Mock<(params: DispatchInboundMessageMockParams) => Promise<TestDispatchResult>>,
): Promise<MsgContext> {
  const dispatched = createDeferred<MsgContext>();
  const dispatch = mock.getMockImplementation()!;
  mock.mockImplementationOnce(async (params) => {
    const result = await dispatch(params);
    dispatched.resolve(params.ctx);
    return result;
  });
  return dispatched.promise;
}
