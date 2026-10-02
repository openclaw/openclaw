import { AsyncLocalStorage } from "node:async_hooks";
import { resolveFetch } from "openclaw/plugin-sdk/fetch-runtime";
import {
  fetchWithRuntimeDispatcher,
  type DispatcherAwareRequestInit,
} from "openclaw/plugin-sdk/runtime-fetch";
import type { ZaloSendHandoff } from "./types.js";

type SendContext = ZaloSendHandoff & { active: boolean };

const sendContext = new AsyncLocalStorage<SendContext>();
const MESSAGE_REQUEST_PATH =
  /^\/api\/(?:message|group)\/(?:sms|sendmsg|link|sendlink|photo_original\/send|asyncfile\/msg|gif|forward)$/u;

function assertCurrent(context: SendContext): void {
  if (!context.active) {
    throw new Error("Zalouser send is no longer active");
  }
  context.signal?.throwIfAborted();
  context.assertDirectAdapterHandoff?.();
}

export async function withZaloSendContext<T>(
  handoff: ZaloSendHandoff,
  operation: () => Promise<T>,
): Promise<T> {
  const context: SendContext = {
    signal: handoff.signal,
    assertDirectAdapterHandoff: handoff.assertDirectAdapterHandoff,
    onPlatformSendDispatch: handoff.onPlatformSendDispatch,
    active: true,
  };
  try {
    return await sendContext.run(context, () => {
      assertCurrent(context);
      return operation();
    });
  } finally {
    // The SDK can reject Promise.all while another request is still preparing.
    context.active = false;
  }
}

export const fetchWithZaloSendContext: typeof fetch = async (input, init) => {
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  const context = sendContext.getStore();
  if (context) {
    assertCurrent(context);
    if (context.onPlatformSendDispatch) {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const url = new URL(input instanceof Request ? input.url : input);
      // zca-js shares this hook with uploads, voice HEAD requests, and lookups.
      if (method === "POST" && MESSAGE_REQUEST_PATH.test(url.pathname)) {
        await context.onPlatformSendDispatch();
        assertCurrent(context);
      }
    }
  }
  return fetchImpl(input, init);
};

export function fetchMediaWithZaloSendContext(
  input: RequestInfo | URL,
  init?: DispatcherAwareRequestInit,
): Promise<Response> {
  const context = sendContext.getStore();
  if (context) {
    assertCurrent(context);
  }
  // The shared media guard supplies a pinned dispatcher that ambient fetch may ignore.
  return fetchWithRuntimeDispatcher(input, init);
}
