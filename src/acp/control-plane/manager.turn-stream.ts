import { AcpRuntimeError } from "../runtime/errors.js";
import type { AcpRuntime, AcpRuntimeEvent, AcpRuntimeTurnInput } from "../runtime/types.js";
import { normalizeAcpErrorCode } from "./manager.utils.js";
import { normalizeText } from "./runtime-options.js";

const TURN_STREAM_TIMEOUT_MS = 30_000;

export type AcpTurnEventGate = {
  open: boolean;
};

export type AcpTurnStreamOutcome = {
  sawOutput: boolean;
  sawTerminalEvent: boolean;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeoutToken = Symbol("timeout");
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<typeof timeoutToken>((resolve) => {
    timer = setTimeout(() => resolve(timeoutToken), timeoutMs);
    if (timer.unref) timer.unref();
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    if (result === timeoutToken) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn stream timed out waiting for events.");
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function consumeAcpTurnStream(params: {
  runtime: AcpRuntime;
  turn: AcpRuntimeTurnInput;
  eventGate: AcpTurnEventGate;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
  onOutputEvent?: (
    event: Extract<AcpRuntimeEvent, { type: "text_delta" | "tool_call" }>,
  ) => Promise<void> | void;
}): Promise<AcpTurnStreamOutcome> {
  let streamError: AcpRuntimeError | null = null;
  let sawOutput = false;
  let sawTerminalEvent = false;
  let streamCompleted = false;

  const runStream = async () => {
    for await (const event of params.runtime.runTurn(params.turn)) {
      streamCompleted = true;
      if (!params.eventGate.open) {
        continue;
      }
      if (event.type === "done") {
        sawTerminalEvent = true;
      } else if (event.type === "error") {
        streamError = new AcpRuntimeError(
          normalizeAcpErrorCode(event.code),
          normalizeText(event.message) || "ACP turn failed before completion.",
        );
      } else if (event.type === "text_delta" || event.type === "tool_call") {
        sawOutput = true;
        await params.onOutputEvent?.(event);
      }
      await params.onEvent?.(event);
    }
    streamCompleted = true;
  };

  await withTimeout(runStream(), TURN_STREAM_TIMEOUT_MS);

  if (params.eventGate.open && streamError) {
    throw streamError;
  }

  if (params.eventGate.open && streamCompleted && !sawTerminalEvent) {
    throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn ended without a terminal done event.");
  }

  return {
    sawOutput,
    sawTerminalEvent,
  };
}
