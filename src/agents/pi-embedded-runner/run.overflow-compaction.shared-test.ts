import { vi } from "vitest";
import {
  mockedContextEngine,
  mockedContextEngineCompact,
} from "./run.overflow-compaction.mocks.shared.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import {
  sessionLikelyHasOversizedToolResults,
  truncateOversizedToolResultsInSession,
} from "./tool-result-truncation.js";

export const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);
export const mockedCompactDirect = mockedContextEngineCompact;
export const mockedSessionLikelyHasOversizedToolResults = vi.mocked(
  sessionLikelyHasOversizedToolResults,
);
export const mockedTruncateOversizedToolResultsInSession = vi.mocked(
  truncateOversizedToolResultsInSession,
);
export { mockedContextEngine };

export const overflowBaseRunParams = {
  sessionId: "test-session",
  sessionKey: "test-key",
  sessionFile: "/tmp/session.json",
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30000,
  runId: "run-1",
} as const;
