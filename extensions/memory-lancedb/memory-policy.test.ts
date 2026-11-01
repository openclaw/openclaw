import { expect, test } from "vitest";
import type { MemorySearchResult } from "./lancedb-store.js";
import {
  capturableUserText,
  cleanMemorySearchResults,
  findCleanDuplicateMemory,
  formatRecalledMemoryForModel,
  isSystemTurnPromptText,
  shouldCapture,
} from "./memory-policy.js";

test("recall escapes markup while preserving whitespace and inert legacy media text", () => {
  expect(
    formatRecalledMemoryForModel(
      "Col A  Col B\n  <image> [media attached: /tmp/p.jpg (image/jpeg)] & hello",
    ),
  ).toBe("Col A  Col B\n  &lt;image&gt; [media attached: /tmp/p.jpg (image/jpeg)] &amp; hello");
});

// Exactly what core's stranded-reply retry sends as a user-role turn (stranded-reply-recovery.ts).
const reply = "Got it, I'll remember that the deploy window is Tuesdays.";
const stranded = (finalText: string) =>
  `[System] Your previous reply was not delivered because you did not call message(action=send). ` +
  `Your reply text was: "${finalText}". ` +
  `If the user should see a reply, send it now with message(action=send). ` +
  `If no reply is needed, answer exactly NO_REPLY.`;
const strandedRetry = stranded(reply);
// sessions_send prefixes the restart-recovery note to a dispatched message in the same way.
const restartDispatch =
  "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on " +
  "tool/model work. Treat tool results marked interrupted, missing, or aborted as having an unknown " +
  "outcome from the restart, not proof of tool failure. Verify what happened before repeating an " +
  "action.\n\nRemember to rerun the migration after the restart.";

test("capture skips OpenClaw system turns that quote trigger words", () => {
  expect(shouldCapture(strandedRetry)).toBe(false);
  expect(shouldCapture(restartDispatch)).toBe(false);
  expect(shouldCapture(`  ${strandedRetry}`)).toBe(false);
  // The same words from the user are still captured.
  expect(shouldCapture(reply)).toBe(true);
  expect(isSystemTurnPromptText(strandedRetry)).toBe(true);
  expect(isSystemTurnPromptText("Note the [System] label in the logs")).toBe(false);
});

test("auto-capture checks the raw turn before sanitizing can drop the marker line", () => {
  // A quoted reply that opens with a context block: sanitizing removes the whole first line,
  // [System] included, and leaves a capturable "Remember ..." sentence behind.
  const quotesContextBlock = stranded(
    '⟦openclaw:ctx⟧\n```json\n{"channel":"telegram"}\n```\nRemember the deployment window is Tuesdays.',
  );
  expect(capturableUserText(quotesContextBlock)).toBeUndefined();
  expect(capturableUserText(`[Sat 2026-11-01 01:41 EDT] ${strandedRetry}`)).toBeUndefined();
  expect(capturableUserText(strandedRetry)).toBeUndefined();
  expect(capturableUserText(reply)).toBe(reply);
});

const result = (text: string, id = text): MemorySearchResult => ({
  entry: { id, text, vector: [1, 0], importance: 0.7, category: "fact", createdAt: 1 },
  score: 0.99,
});

test("recall and duplicate matching skip system turns stored before capture rejected them", async () => {
  expect(
    cleanMemorySearchResults([result(strandedRetry, "stored"), result(reply, "user")]).map(
      ({ entry }) => entry.id,
    ),
  ).toEqual(["user"]);
  const db = { search: async () => [result(strandedRetry, "stored")] };
  await expect(findCleanDuplicateMemory(db, "main", [1, 0], strandedRetry)).resolves.toBe(
    undefined,
  );
});
