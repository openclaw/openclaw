export type RealtimeConsultVisiblePartial = {
  runId: string;
  text: string;
  replace?: true;
};

export type RealtimeConsultSpeechStream = {
  cancel(): void;
  finish(finalText: string): boolean;
  push(partial: RealtimeConsultVisiblePartial): void;
  start(runId: string): void;
};

/**
 * Buffers cumulative visible-answer snapshots into stable speakable boundaries.
 * One instance belongs to one bridge generation and accepts exactly one agent run.
 */
export function createRealtimeConsultSpeechStream(params: {
  deliver: (text: string) => void;
  onCancel?: () => void;
}): RealtimeConsultSpeechStream {
  let activeRunId: string | undefined;
  let currentText = "";
  let committedText = "";
  let delivered = false;
  let stopped = false;

  const deliver = (text: string) => {
    const speakable = text.trim();
    if (!speakable || stopped) {
      return;
    }
    try {
      params.deliver(speakable);
      delivered = true;
    } catch (error) {
      stopped = true;
      params.onCancel?.();
      throw error;
    }
  };

  const flushStableText = () => {
    if (!currentText.startsWith(committedText)) {
      return;
    }
    let cursor = committedText.length;
    while (cursor < currentText.length) {
      const boundary = findStableSpeechBoundary(currentText, cursor);
      if (boundary === undefined) {
        return;
      }
      deliver(currentText.slice(cursor, boundary));
      cursor = boundary;
      while (cursor < currentText.length && /\s/.test(currentText[cursor]!)) {
        cursor += 1;
      }
      committedText = currentText.slice(0, cursor);
    }
  };

  return {
    start(runId) {
      if (!stopped && !activeRunId) {
        activeRunId = runId;
      }
    },
    push(partial) {
      if (stopped || !activeRunId || partial.runId !== activeRunId) {
        return;
      }
      currentText = partial.text.trim();
      flushStableText();
    },
    finish(finalText) {
      if (stopped) {
        return false;
      }
      const final = finalText.trim();
      if (final.startsWith(committedText)) {
        deliver(final.slice(committedText.length));
      } else if (delivered && final) {
        deliver(buildCorrection(committedText, final));
      } else {
        deliver(final);
      }
      stopped = true;
      return delivered;
    },
    cancel() {
      if (stopped) {
        return;
      }
      stopped = true;
      params.onCancel?.();
    },
  };
}

function findStableSpeechBoundary(text: string, start: number): number | undefined {
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\n" && text[index + 1] === "\n") {
      return index;
    }
    if (
      (character === "." || character === "!" || character === "?") &&
      (index === text.length - 1 || /\s/.test(text[index + 1]!))
    ) {
      return index + 1;
    }
  }
  return undefined;
}

function buildCorrection(spoken: string, final: string): string {
  const spokenWords = spoken.trim().split(/\s+/);
  const finalWords = final.split(/\s+/);
  let sharedWords = 0;
  while (
    sharedWords < spokenWords.length &&
    sharedWords < finalWords.length &&
    spokenWords[sharedWords] === finalWords[sharedWords]
  ) {
    sharedWords += 1;
  }
  if (sharedWords === finalWords.length && sharedWords < spokenWords.length) {
    if (!final) {
      return "Correction: disregard the previous answer.";
    }
    const anchor = finalWords.slice(-8).join(" ");
    return `Correction: disregard the previous ending after "${anchor}".`;
  }
  const correction = finalWords.slice(sharedWords).join(" ").trim();
  return `Correction: ${correction || final}`;
}
