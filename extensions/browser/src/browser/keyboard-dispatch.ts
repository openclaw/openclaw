import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type { InteractionTargetOptions } from "./pw-tools-core.interactions.navigation.js";

const pendingKeyboardInteractions = new Map<string, Promise<void>>();

export function reserveKeyboardInteraction(opts: InteractionTargetOptions) {
  const key = JSON.stringify([opts.cdpUrl, opts.targetId]);
  const previous = pendingKeyboardInteractions.get(key);
  const { promise, resolve } = createDeferred();
  pendingKeyboardInteractions.set(key, promise);
  let dispatched = false;
  const release = () => {
    resolve();
    if (pendingKeyboardInteractions.get(key) === promise) {
      pendingKeyboardInteractions.delete(key);
    }
  };
  return {
    ready: previous,
    async dispatch(action: () => Promise<void>) {
      dispatched = true;
      try {
        await action();
      } finally {
        release();
      }
    },
    releaseIfUnused() {
      // Foreground interruption can return while native input is still running.
      // Only setup/authority failures release here; dispatched input owns its slot.
      if (!dispatched) {
        release();
      }
    },
  };
}

export type KeyboardDispatch = ReturnType<typeof reserveKeyboardInteraction>;
