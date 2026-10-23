import { digestToolOutcome } from "./tool-loop-outcome-hash.js";

// Retained receipts need only their digest, never a second copy of the guest payload.
const outcomes = new WeakMap<object, string>();

type PendingOperation = {
  method: string;
  args: unknown[];
  settled?: boolean;
};

export function recordCodeModeToolOutcome<T extends object>(
  result: T,
  payload: Record<string, unknown>,
  pending?: readonly PendingOperation[],
): T {
  const retained = outcomes.get(payload);
  if (retained !== undefined) {
    outcomes.set(result, retained);
    return result;
  }
  const { telemetry: _telemetry, runId: _runId, pendingToolCalls, ...outcome } = payload;
  outcomes.set(
    result,
    digestToolOutcome({
      ...outcome,
      // Compare the actual operation, not the fresh bridge request identifier.
      pending: pending
        ? pending.filter((entry) => !entry.settled).map(({ method, args }) => ({ method, args }))
        : pendingToolCalls,
    }),
  );
  return result;
}

export function getCodeModeToolOutcome(result: object): string | undefined {
  return outcomes.get(result);
}
