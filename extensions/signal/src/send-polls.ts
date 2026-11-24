import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { PollInput } from "openclaw/plugin-sdk/poll-runtime";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest } from "./client-adapter.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { resolveSignalRpcContext } from "./rpc-context.js";
import type { SignalRpcOpts } from "./send.js";

/** signal-cli rejects polls with more options (`SendPollCreateCommand.MAX_POLL_OPTIONS`). */
export const SIGNAL_POLL_MAX_OPTIONS = 10;

/** Sends a native Signal poll; the returned message id is the poll's own sent timestamp. */
export async function sendPollSignal(
  to: string,
  poll: PollInput,
  opts: SignalRpcOpts & { assertDirectAdapterHandoff?: () => void },
): Promise<{ messageId: string }> {
  const cfg = requireRuntimeConfig(opts.cfg, "Signal polls");
  const accountInfo = resolveSignalAccount({ cfg, accountId: opts.accountId });
  const transportKind = opts.transportKind ?? accountInfo.transport.kind;
  if (transportKind === "container") {
    throw new Error("Signal polls require a native signal-cli transport");
  }
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const target = normalizeSignalMessagingTarget(to);
  if (!target) {
    throw new Error("Recipient or group is required for a Signal poll");
  }
  const targetParams = target.startsWith("group:")
    ? { groupId: [target.slice("group:".length)] }
    : target.startsWith("username:")
      ? { username: [target.slice("username:".length)] }
      : { recipient: [target] };
  const params: Record<string, unknown> = {
    question: poll.question,
    option: poll.options,
    // Signal polls allow multiple answers unless the sender opts out.
    ...((poll.maxSelections ?? 1) === 1 ? { "no-multi": true } : {}),
    ...targetParams,
    ...(account ? { account } : {}),
  };
  const result = await signalRpcRequest<{ timestamp?: number }>("sendPollCreate", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
    transportKind,
    assertDirectAdapterHandoff: opts.assertDirectAdapterHandoff,
  });
  if (typeof result?.timestamp !== "number") {
    throw new Error("Signal poll was sent without a timestamp");
  }
  return { messageId: String(result.timestamp) };
}
