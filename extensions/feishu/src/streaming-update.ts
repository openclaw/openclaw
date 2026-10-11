import type { RuntimeEnv } from "../runtime-api.js";
import type { FeishuStreamingSession } from "./streaming-card.js";

/** Admit captured snapshots in order while the session owns provider writes. */
export function queueFeishuStreamingUpdate(params: {
  queue: Promise<void>;
  session: FeishuStreamingSession | null;
  startPromise: Promise<void> | null;
  text: string;
  accountId: string;
  runtime: RuntimeEnv;
}): Promise<void> {
  const { queue, session, startPromise, text, accountId, runtime } = params;
  return queue.then(async () => {
    if (startPromise) {
      await startPromise;
    }
    if (session?.isActive()) {
      // update admits pending text synchronously. Let the session own write ordering
      // and replacement; awaiting transport here would serialize obsolete snapshots.
      // Its retained write queue still propagates failures through awaited close/discard.
      void session
        .update(text)
        .catch((error: unknown) =>
          runtime.error?.(`feishu[${accountId}] streaming update failed: ${String(error)}`),
        );
    }
  });
}
