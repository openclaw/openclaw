type RealtimeConsultVisiblePartial = {
  runId: string;
  text: string;
  delta?: string;
  replace?: true;
};

export type RealtimeConsultSpeechStream = {
  cancel(): void;
  finish(finalText: string): Promise<{
    suppressResponse: boolean;
    fallbackText?: string;
  }>;
  push(partial: RealtimeConsultVisiblePartial): Promise<void>;
  start(runId: string): void;
};

/**
 * Turns cumulative or append-only visible-answer updates into ordered sentence speech.
 * One instance belongs to one bridge generation and accepts exactly one agent run.
 */
export function createRealtimeConsultSpeechStream(params: {
  deliver: (text: string) => Promise<void> | void;
  maxChars?: number;
  onCancel?: () => void;
}): RealtimeConsultSpeechStream {
  let activeRunId: string | undefined;
  let currentText = "";
  let committedText = "";
  let delivered = false;
  let cancelled = false;
  let failed = false;
  let cancellationNotified = false;
  let deliveryTail = Promise.resolve();

  const notifyCancellation = () => {
    if (!cancellationNotified) {
      cancellationNotified = true;
      params.onCancel?.();
    }
  };

  const deliver = async (text: string) => {
    const speakable = text.trim();
    if (!speakable || cancelled || failed) {
      return;
    }
    await params.deliver(speakable);
    if (!cancelled && !failed) {
      delivered = true;
    }
  };

  const flushStableText = async () => {
    if (!currentText.startsWith(committedText)) {
      return;
    }
    let cursor = committedText.length;
    while (cursor < currentText.length) {
      if (cancelled || failed) {
        return;
      }
      const boundary = findStableSpeechBoundary(currentText, cursor);
      if (boundary === undefined) {
        return;
      }
      await deliver(currentText.slice(cursor, boundary));
      cursor = boundary;
      committedText = currentText.slice(0, cursor);
    }
  };

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const queued = deliveryTail.then(async () => {
      if (!cancelled && !failed) {
        await task();
      }
    });
    deliveryTail = queued.catch(() => {});
    return queued.catch((error: unknown) => {
      if (cancelled) {
        return;
      }
      failed = true;
      notifyCancellation();
      throw error;
    });
  };

  return {
    start(runId) {
      if (!cancelled && !failed && !activeRunId) {
        activeRunId = runId;
      }
    },
    push(partial) {
      return enqueue(async () => {
        if (!activeRunId || partial.runId !== activeRunId) {
          return;
        }
        currentText = truncateUtf16Safe(
          mergePartialText(currentText, partial),
          params.maxChars ?? 1_800,
        );
        await flushStableText();
      });
    },
    async finish(finalText) {
      await deliveryTail;
      if (cancelled) {
        return { suppressResponse: false };
      }
      if (failed) {
        const fallbackText = delivered ? readUnspokenSuffix(committedText, finalText) : undefined;
        return {
          suppressResponse: false,
          ...(fallbackText ? { fallbackText } : {}),
        };
      }
      if (!delivered) {
        cancelled = true;
        return { suppressResponse: false };
      }
      try {
        const final = finalText.trim();
        if (final.startsWith(committedText)) {
          await deliver(final.slice(committedText.length));
        } else if (delivered && final) {
          await deliver(`Correction: ${final}`);
        }
      } catch {
        failed = true;
        notifyCancellation();
        return {
          suppressResponse: false,
          ...(delivered ? { fallbackText: readUnspokenSuffix(committedText, finalText) } : {}),
        };
      }
      cancelled = true;
      return { suppressResponse: delivered };
    },
    cancel() {
      if (cancelled || failed) {
        return;
      }
      cancelled = true;
      notifyCancellation();
    },
  };
}

function mergePartialText(current: string, partial: RealtimeConsultVisiblePartial): string {
  if (partial.replace) {
    return partial.text;
  }
  if (partial.delta !== undefined) {
    if (!current || partial.text.startsWith(current)) {
      return partial.text;
    }
    return `${current}${partial.delta}`;
  }
  if (!current || partial.text.startsWith(current)) {
    return partial.text;
  }
  if (current.startsWith(partial.text)) {
    return current;
  }
  return `${current}${partial.text}`;
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

function truncateUtf16Safe(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const sliced = value.slice(0, maxChars);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

function readUnspokenSuffix(spoken: string, finalText: string): string {
  const final = finalText.trim();
  if (final.startsWith(spoken)) {
    const suffix = final.slice(spoken.length).trim();
    if (suffix) {
      return suffix;
    }
  }
  return "I lost the rest of that live update before it finished.";
}
