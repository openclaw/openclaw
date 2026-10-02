import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { IMessageRpcRequestError, type IMessageRpcClient } from "./client.js";

export type IMessageSendHandoff = {
  assertDirectAdapterHandoff?: () => void;
  onPlatformSendDispatch?: () => Promise<void>;
};

function normalizeIMessageRpcSendError(error: unknown): unknown {
  if (!(error instanceof IMessageRpcRequestError)) {
    return error;
  }
  const data = asOptionalRecord(error.data);
  return data?.disposition === "not_started" && data.retry_safe === true
    ? new PlatformMessageNotDispatchedError(error.message, { cause: error })
    : error;
}

export async function requestIMessageRpcSend(
  client: IMessageRpcClient,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  handoff: IMessageSendHandoff,
): Promise<Record<string, unknown>> {
  handoff.assertDirectAdapterHandoff?.();
  await handoff.onPlatformSendDispatch?.();
  // The RPC client writes stdin synchronously. Keep this check after dispatch
  // refresh and in the same continuation as the actual native request.
  handoff.assertDirectAdapterHandoff?.();
  try {
    return await client.request<Record<string, unknown>>(method, params, { timeoutMs });
  } catch (error) {
    throw normalizeIMessageRpcSendError(error);
  }
}
