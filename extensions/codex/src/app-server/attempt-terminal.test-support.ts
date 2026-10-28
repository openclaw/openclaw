import { expect } from "vitest";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";

export const projectAttemptResult = (result: EmbeddedRunAttemptResult) => ({
  ...result,
  ...readAttemptTerminal(result),
});

export function expectSuccessfulAttempt(result: EmbeddedRunAttemptResult): void {
  expect(readAttemptTerminal(result).aborted).toBe(false);
  expect(readAttemptTerminal(result).timedOut).toBe(false);
  expect(readAttemptTerminal(result).promptError).toBeNull();
}

export function expectTimedOutAttempt(result: EmbeddedRunAttemptResult): void {
  expect(readAttemptTerminal(result).aborted).toBe(true);
  expect(readAttemptTerminal(result).timedOut).toBe(true);
  expect(readAttemptTerminal(result).promptError).toBe(
    "codex app-server execution budget timed out",
  );
}
