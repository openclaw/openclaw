import { REPETITIVE_OUTPUT_ERROR_CODE, type AssistantMessage } from "@openclaw/llm-core/types";
import { REPETITIVE_OUTPUT_ERROR_MESSAGE } from "./errors.js";
import { RepetitionWatch } from "./repetition-guard.js";

/** Tracks each text/reasoning block once, including providers that only emit final snapshots. */
export class AssistantRepetitionGuard {
  private blocks = new Map<number, { watch: RepetitionWatch; text: string }>();

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
      // Length alone proves an append; a same-length snapshot correction is accepted as stale history.
      const knownAppend =
        delta !== undefined && text.length === (state?.text.length ?? 0) + delta.length;
      if (!state || (!knownAppend && !text.startsWith(state.text))) {
        state = { watch: new RepetitionWatch(), text: "" };
        this.blocks.set(index, state);
      }
      const stopped = state.watch.feed(knownAppend ? delta : text.slice(state.text.length));
      state.text = text;
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
