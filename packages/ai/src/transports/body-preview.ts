import { randomUUID } from "node:crypto";
import type { AssistantMessageEvent } from "@openclaw/llm-core";
import { createReasoningTagTextPartitioner } from "../utils/reasoning-tag-text-partitioner.js";
import { createDeepSeekTextFilter } from "./deepseek-text-filter.js";

/** Ephemeral public-content snapshots; never mutate the canonical assistant output. */
export function createBodyPreview(
  filterDsml: boolean,
  push: (event: AssistantMessageEvent) => void,
) {
  const previewId = randomUUID();
  const partitioner = createReasoningTagTextPartitioner();
  const dsml = filterDsml ? createDeepSeekTextFilter() : undefined;
  let revision = 0;
  let text = "";
  let emittedLength = 0;
  let disabled = false;
  let inputBytes = 0;
  const emit = (reset: boolean) =>
    push({ type: "text_preview", previewId, revision: ++revision, text, reset });
  const clear = () => {
    if (!text) {
      return;
    }
    text = "";
    emittedLength = 0;
    emit(true);
  };
  return {
    content(chunk: string) {
      if (disabled) {
        return;
      }
      inputBytes += Buffer.byteLength(chunk, "utf8");
      if (inputBytes > 256_000) {
        disabled = true;
        clear();
        return;
      }
      let addition = "";
      for (const safe of dsml?.push(chunk) ?? [chunk]) {
        for (const part of partitioner.pushVisible(safe)) {
          if (part.kind === "text") {
            addition += part.text;
          }
        }
      }
      if (addition) {
        text += addition;
        // Grow snapshots geometrically after a small-text floor. This bounds
        // total copied/reparsed preview text even for one-character deltas.
        const minimumGrowth = Math.max(16, Math.ceil(emittedLength / 32));
        if (emittedLength === 0 || text.length - emittedLength >= minimumGrowth) {
          emittedLength = text.length;
          emit(false);
        }
      }
    },
    deltas(parts: readonly { kind: string; text: string }[], reasoning: boolean, tools: boolean) {
      if (reasoning) {
        clear();
      }
      if (tools) {
        this.stop();
        return;
      }
      for (const part of parts) {
        if (part.kind === "text") {
          this.content(part.text);
        } else {
          clear();
        }
      }
    },
    // Retain parser state across native reasoning so a split/open tag cannot escape.
    reasoning: clear,
    stop() {
      disabled = true;
      clear();
    },
    // Do not flush either parser: incomplete tags must never recover as preview text.
    // The unchanged terminal projection owns any remaining visible tail.
  };
}
