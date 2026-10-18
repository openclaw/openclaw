import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  captureChannelReadAuthority,
  captureEffectAuthority,
} from "openclaw/plugin-sdk/fetch-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { runIMessageCliJsonCommand } from "./cli-output.js";
import { IMessageRpcRequestError, type IMessageRpcClient } from "./client.js";

export type IMessageSendHandoff = {
  assertDirectAdapterHandoff?: () => void;
  onPlatformSendDispatch?: () => Promise<void>;
};

export function bindIMessageCliSend(
  handoff: IMessageSendHandoff & {
    runCliJson?: (args: readonly string[]) => Promise<Record<string, unknown>>;
  },
  options: Omit<Parameters<typeof runIMessageCliJsonCommand>[0], "args">,
) {
  const effect = captureEffectAuthority();
  const assertReadAuthority = captureChannelReadAuthority();
  const runCli =
    handoff.runCliJson ??
    ((args: readonly string[]) => runIMessageCliJsonCommand({ ...options, args }));
  return (args: readonly string[]) =>
    effect.initiate(() => {
      // Lookup commands retain authority without recording visible dispatch.
      assertReadAuthority?.();
      handoff.assertDirectAdapterHandoff?.();
      return runCli(args);
    });
}

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
  handoff.assertDirectAdapterHandoff?.();
  try {
    return await client.request<Record<string, unknown>>(method, params, {
      timeoutMs,
      assertCurrent: handoff.assertDirectAdapterHandoff,
    });
  } catch (error) {
    throw normalizeIMessageRpcSendError(error);
  }
}
