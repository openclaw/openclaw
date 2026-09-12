import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";

// Dist and source copies share physical clients, so their lifecycle queues must
// share ownership too. Settled entries drain naturally; never clear active tails.
const nativeThreadOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.codexNativeThreadOwners"),
  () => new KeyedAsyncQueue(),
);

/** Serialize OpenClaw-owned lifecycle changes, not native-internal thread controllers. */
export async function withCodexAppServerThreadMutation<T>(
  threadId: string,
  run: () => Promise<T>,
): Promise<T> {
  return await nativeThreadOwners.enqueue(`thread:${threadId}`, run);
}

/** Runs a mutation while retaining the lane after an uncertain cleanup. */
export function withCodexAppServerThreadMutationHold<T>(
  threadId: string,
  run: (hold: (until: Promise<unknown>) => void) => Promise<T>,
): Promise<T> {
  let resolveResult!: (value: T | PromiseLike<T>) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let heldUntil: Promise<unknown> | undefined;
  const queued = nativeThreadOwners.enqueue(`thread:${threadId}`, async () => {
    try {
      resolveResult(
        await run((until) => {
          heldUntil ??= until;
        }),
      );
    } catch (error) {
      rejectResult(error);
    }
    await heldUntil;
  });
  void queued.catch((error) => rejectResult(error));
  return result;
}

/** Serializes bound turns and retirement so detach cannot unsubscribe an active turn. */
export async function withCodexConversationThreadActivity<T>(
  bindingId: string,
  run: () => Promise<T>,
): Promise<T> {
  return await nativeThreadOwners.enqueue(`conversation:${bindingId}`, run);
}
