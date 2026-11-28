import { REPETITIVE_OUTPUT_ERROR_CODE, type AssistantMessage } from "@openclaw/llm-core/types";
import { REPETITIVE_OUTPUT_ERROR_MESSAGE } from "./errors.js";
import { RepetitionWatch } from "./repetition-guard.js";

/**
 * Tracks each text/reasoning block once, including providers that only emit final snapshots.
 * A delta takes its offset from the stream and reads only the snapshot's length: a queued
 * event's snapshot can already hold later chunks, and reading the content of a growing string
 * flattens it, O(block) per delta. Events without a delta verify the snapshot once in full.
 */
export class AssistantRepetitionGuard {
  // `seen`: the block text the watch has seen. `deltaEnd`: block offset after the last delta.
  // Length cannot tell a queued snapshot from one that is current, so a snapshot ahead of its
  // deltas skews only the live watch; the full check at the next event without a delta re-feeds.
  private blocks = new Map<number, { watch: RepetitionWatch; seen: string; deltaEnd: number }>();

  check(
    message: AssistantMessage,
    committed: number,
    contentIndex?: number,
    delta?: string,
  ): AssistantMessage | undefined {
    const end = contentIndex === undefined ? message.content.length : contentIndex + 1;
    for (let index = contentIndex ?? committed; index < end; index++) {
      const block = message.content[index];
      const text =
        block?.type === "text"
          ? block.text
          : block?.type === "thinking"
            ? block.thinking
            : undefined;
      if (text === undefined || index < committed) {
        continue;
      }
      let state = this.blocks.get(index);
      let fresh: string | undefined;
      if (state && text.length >= state.seen.length) {
        if (delta !== undefined) {
          const offset = state.deltaEnd;
          state.deltaEnd += delta.length;
          fresh = delta.slice(Math.max(0, state.seen.length - offset));
        } else if (text.startsWith(state.seen)) {
          fresh = text.slice(state.seen.length);
        }
      }
      if (fresh === undefined) {
        // New block, or the snapshot rewrote what the watch saw: watch the snapshot from the start.
        state = {
          watch: new RepetitionWatch(),
          seen: "",
          deltaEnd: state ? text.length : (delta?.length ?? 0),
        };
        this.blocks.set(index, state);
        fresh = text;
      }
      state.seen += fresh;
      const stopped = state.watch.feed(fresh);
      if (stopped) {
        // A server-side checkpoint could replay the discarded block even with clean visible text.
        return {
          ...message,
          providerReplay: undefined,
          content: [
            ...message.content.slice(0, committed),
            ...message.content.slice(committed, index).filter((item) => item.type !== "toolCall"),
            { type: "text", text: "[Repetitive output stopped]" },
          ],
          stopReason: "error",
          endTurn: true,
          errorCode: REPETITIVE_OUTPUT_ERROR_CODE,
          errorMessage: REPETITIVE_OUTPUT_ERROR_MESSAGE,
        };
      }
    }
    return undefined;
  }
}
