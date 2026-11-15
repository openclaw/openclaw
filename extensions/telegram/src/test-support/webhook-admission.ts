import { createChannelIngressQueueForTests as createChannelIngressQueue } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";

export function createTelegramWebhookIdleAdmissionFixture(resolveStateDir: () => string) {
  const enqueueGate = createDeferred<void>();
  const enqueueStarted = createDeferred<void>();
  const runtime = createPluginRuntimeMock({
    state: {
      resolveStateDir,
      openChannelIngressQueue: <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
        options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
      ) => {
        const queue = createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>({
          ...options,
          channelId: "telegram",
        });
        const enqueueAndClaim = queue.enqueueAndClaim?.bind(queue);
        if (!enqueueAndClaim) {
          throw new Error("Expected the durable queue's idle admission operation");
        }
        return {
          ...queue,
          enqueueAndClaim: async (...args: Parameters<typeof enqueueAndClaim>) => {
            enqueueStarted.resolve();
            await enqueueGate.promise;
            return await enqueueAndClaim(...args);
          },
        };
      },
    },
  });
  return { runtime, enqueueGate, enqueueStarted };
}
