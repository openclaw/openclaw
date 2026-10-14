import { createChannelProgressDraftCompositor } from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyDispatchRuntimeInfo } from "openclaw/plugin-sdk/reply-runtime";
import type { createDiscordDraftStream } from "../draft-stream.js";
import { withDiscordRequestAuthority } from "../internal/request-authority.js";

type CompositorParams = Parameters<typeof createChannelProgressDraftCompositor>[0];
type RetainedDraft = Parameters<NonNullable<ReplyDispatchRuntimeInfo["adoptProgressDraft"]>>[0];

/** The registry owns task settlement; Discord keeps the confirmed transport and its cleanup. */
export function retainDiscordProgressDraft(params: {
  stream: ReturnType<typeof createDiscordDraftStream>;
  snapshot: NonNullable<CompositorParams["initialSnapshot"]>;
  entry: CompositorParams["entry"];
  seed: string;
  log: (message: string) => void;
  runInChannelScope: <T>(run: () => T) => T;
  isPolicyCurrent?: () => boolean;
  assertChannelAuthority?: () => void;
}): RetainedDraft {
  let retired = false;
  const assertChannelCurrent = () => {
    // Explicit flushes may run outside the captured async scope. The transport
    // still revalidates its original channel owner at every admission.
    params.assertChannelAuthority?.();
    if (params.isPolicyCurrent?.() === false) {
      throw new Error("Discord channel policy is no longer current");
    }
  };
  const assertCurrent = () => {
    assertChannelCurrent();
    if (retired) {
      throw new Error("Discord retained progress authority is no longer current");
    }
  };
  const compositor = createChannelProgressDraftCompositor({
    preparedItems: true,
    showWorkStatus: true,
    entry: params.entry,
    mode: "progress",
    active: true,
    seed: params.seed,
    reasoningGate: false,
    toolIcons: true,
    initialSnapshot: params.snapshot,
    update: async (text, options) => {
      if (retired) {
        return false;
      }
      // The REST scheduler rechecks this exact custody before admission/retries.
      params.stream.update(text, { complete: true, assertCurrent });
      if (options.flush) {
        await params.stream.flush();
      }
      return params.stream.lastDeliveredText() === text;
    },
  });
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (work: () => Promise<unknown>) => {
    queue = params.runInChannelScope(() =>
      queue.then(work).catch((error: unknown) => {
        params.log("discord: retained progress failed (" + String(error) + ")");
      }),
    );
  };
  let started = false;
  return {
    push: (item) =>
      enqueue(async () => {
        if (retired) {
          return;
        }
        if (!started) {
          started = true;
          await compositor.start();
        }
        await compositor.pushItemEvent(item);
      }),
    retire: () => {
      if (retired) {
        return;
      }
      retired = true;
      compositor.markFinalReplyStarted();
      enqueue(() =>
        withDiscordRequestAuthority(assertChannelCurrent, async () => {
          await params.stream.clear();
          await params.stream.cleanupPendingMessages();
        }),
      );
    },
  };
}
