import { vi } from "vitest";

vi.mock("../../transcript-policy.js", () => ({
  resolveTranscriptPolicy: () => ({
    allowSyntheticToolResults: false,
    repairToolUseResultPairing: true,
  }),
}));

vi.mock("../../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../config/sessions/session-entry-read-runtime.js")>();
  const readSessionEntryInWorker: typeof actual.readSessionEntryInWorker = async (
    _scope,
    assertCurrent,
  ) => {
    // These attempt fixtures have no quota-recovery entry; retain the async admission boundary.
    assertCurrent?.();
    await Promise.resolve();
    assertCurrent?.();
    return undefined;
  };
  return { ...actual, readSessionEntryInWorker };
});
