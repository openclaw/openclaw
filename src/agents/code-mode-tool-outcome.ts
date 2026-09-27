import { stableStringify } from "@openclaw/normalization-core";

// These identities never cross the guest bridge or change the delivered receipt.
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
    stableStringify({
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
