import { AsyncLocalStorage } from "node:async_hooks";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { ChannelOutboundAdapter } from "../runtime-api.js";

type FeishuSendContext = Pick<
  Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0],
  "signal" | "assertDirectAdapterHandoff" | "onPlatformSendDispatch"
>;

type FeishuSendScope = {
  assertCurrent: () => void;
  onPlatformSendDispatch?: () => Promise<void>;
  recipientVisible?: true;
};

const sendScope = new AsyncLocalStorage<FeishuSendScope>();

/** Mutation errors preserve uncertainty after earlier requests reached the provider. */
export function withFeishuRequestContext<T>(
  assertCurrent: (() => void) | undefined,
  request: () => Promise<T>,
): Promise<T> {
  return assertCurrent ? sendScope.run({ assertCurrent }, request) : request();
}

/** Keep invocation authority out of the shared, account-cached SDK client. */
export function withFeishuSendContext<T>(
  context: FeishuSendContext,
  send: () => Promise<T>,
): Promise<T> {
  const { signal, assertDirectAdapterHandoff, onPlatformSendDispatch } = context;
  if (!signal && !assertDirectAdapterHandoff && !onPlatformSendDispatch) {
    return send();
  }
  const assertCurrent = () => {
    try {
      signal?.throwIfAborted();
      assertDirectAdapterHandoff?.();
    } catch (cause) {
      throw new PlatformMessageNotDispatchedError("Feishu sender retired before request dispatch", {
        cause,
        retryable: false,
      });
    }
  };
  // The host owns this lifetime, including pending typing cleanup. Returning a
  // send result restores the ambient binding without inventing another expiry.
  return sendScope.run({ assertCurrent, onPlatformSendDispatch }, send);
}

export function captureFeishuSendAuthority(): (() => void) | undefined {
  return sendScope.getStore()?.assertCurrent;
}

/** Only recipient-visible request owners opt into durable dispatch accounting. */
export function withFeishuMessageDispatch<T>(request: () => Promise<T>): Promise<T> {
  const scope = sendScope.getStore();
  scope?.assertCurrent();
  return scope ? sendScope.run({ ...scope, recipientVisible: true }, request) : request();
}

export function captureFeishuSendContext(): FeishuSendScope | undefined {
  return sendScope.getStore();
}

export async function runBeforeFeishuMessageDispatch<T>(
  operation: () => Promise<T> | T,
): Promise<T> {
  try {
    captureFeishuSendAuthority()?.();
    return await operation();
  } catch (error: unknown) {
    if (error instanceof PlatformMessageNotDispatchedError) {
      throw error;
    }
    throw new PlatformMessageNotDispatchedError(
      `Feishu media preparation failed before message dispatch: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}
