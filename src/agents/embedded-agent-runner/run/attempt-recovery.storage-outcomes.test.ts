import { beforeEach, expect, it, vi } from "vitest";
import { sleepWithAbort } from "../../../infra/backoff.js";
import { recoverAfterTransportDrop } from "./attempt-recovery.test-support.js";

vi.mock("../../../infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/backoff.js")>()),
  sleepWithAbort: vi.fn(async () => {}),
}));

beforeEach(() => vi.mocked(sleepWithAbort).mockClear());

it.each([
  { errorCode: "session_actor_reconciliation", expectedTerminal: true },
  { errorCode: "57014", errorType: "PostgresQueryCanceledError", expectedTerminal: true },
  {
    errorCode: "57014",
    errorType: "PostgresQueryCanceledError",
    errorMessage: "canceling statement due to statement timeout",
    expectedTerminal: true,
  },
  { errorCode: "unavailable", errorType: "SqliteWorkerError", expectedTerminal: false },
  { errorCode: "57014", expectedTerminal: false },
])(
  "keeps typed storage terminal=$expectedTerminal for $errorCode/$errorType",
  async ({ expectedTerminal, ...scenario }) => {
    const fixture = await recoverAfterTransportDrop({
      errorMessage: "Connection error.",
      ...scenario,
      diagnostics: [],
      noTools: true,
      replaySafe: true,
      content: [],
    });
    expect(fixture.recovery.action).toBe(expectedTerminal ? "proceed" : "retry");
    if (expectedTerminal) {
      expect(sleepWithAbort).not.toHaveBeenCalled();
      expect(fixture.continueFromCurrentTranscript).not.toHaveBeenCalled();
      expect(fixture.markOwnedTranscriptRetry).not.toHaveBeenCalled();
    } else {
      expect(sleepWithAbort).toHaveBeenCalledOnce();
      expect(fixture.continueFromCurrentTranscript).toHaveBeenCalledOnce();
    }
  },
);
