import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createReplyDispatcher, settleReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { qaChannelPlugin } from "../../qa-channel/api.js";
import { createQaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

// Both completion scenarios use the real channel/poller with only model execution injected.
export function createScenarioChannel() {
  const state = createQaBusState();
  const transport = createQaChannelTransport(state);
  const runtime = createPluginRuntimeMock({
    channel: { inbound: { buildContext: buildChannelInboundEventContext } },
  });
  return {
    state,
    transport,
    runtime,
    start(baseUrl: string) {
      const controller = new AbortController();
      const ready = createDeferred<void>();
      const cfg = transport.createGatewayConfig({ baseUrl });
      const context = createStartAccountContext({
        account: qaChannelPlugin.config.resolveAccount(cfg, transport.accountId),
        cfg,
        abortSignal: controller.signal,
        statusPatchSink: (snapshot) => {
          if (snapshot.lifecycle === "ready") {
            ready.resolve();
          }
        },
      });
      const startAccount = qaChannelPlugin.gateway?.startAccount;
      if (!startAccount) {
        throw new Error("expected QA channel gateway entry point");
      }
      const gateway = Promise.resolve(
        startAccount({ ...context, channelRuntime: runtime.channel }),
      );
      return {
        gateway,
        abort: () => controller.abort(),
        ready: Promise.race([
          ready.promise,
          gateway.then(() => {
            throw new Error("QA channel stopped before ready");
          }),
        ]),
      };
    },
  };
}

export async function dispatchScenarioFinal(
  options: Parameters<typeof createReplyDispatcher>[0],
  final?: Parameters<ReturnType<typeof createReplyDispatcher>["sendFinalReply"]>[0],
) {
  const dispatcher = createReplyDispatcher(options);
  try {
    if (final !== undefined) {
      dispatcher.sendFinalReply(final);
    }
  } finally {
    await settleReplyDispatcher({ dispatcher });
  }
  return { queuedFinal: final !== undefined, counts: dispatcher.getQueuedCounts() };
}
