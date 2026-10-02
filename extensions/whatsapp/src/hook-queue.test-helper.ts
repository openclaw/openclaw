import { fireAndForgetBoundedHook } from "openclaw/plugin-sdk/hook-runtime";

/** Resolves after earlier jobs on the shared hook queue reach their task factories. */
export function enqueueWhatsAppHookQueueBarrierForTests(): Promise<void> {
  let resolveBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => {
    resolveBarrier = resolve;
  });
  const admitted = fireAndForgetBoundedHook(
    () => {
      resolveBarrier();
      return Promise.resolve();
    },
    "test: drain WhatsApp hook queue",
    () => {},
    { maxConcurrency: 8, maxQueue: 128, timeoutMs: 60_000 },
  );
  if (!admitted) {
    throw new Error("failed to enqueue WhatsApp hook queue barrier");
  }
  return barrier;
}
