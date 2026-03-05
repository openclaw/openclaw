import { vi } from "vitest";
import { compactEmbeddedPiSessionDirect } from "./compact.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import {
  sessionLikelyHasOversizedToolResults,
  truncateOversizedToolResultsInSession,
} from "./tool-result-truncation.js";

export const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);
export const mockedCompactDirect = vi.mocked(compactEmbeddedPiSessionDirect);
export const mockedSessionLikelyHasOversizedToolResults = vi.mocked(
  sessionLikelyHasOversizedToolResults,
);
export const mockedTruncateOversizedToolResultsInSession = vi.mocked(
  truncateOversizedToolResultsInSession,
);

export const overflowBaseRunParams = {
  sessionId: "test-session",
  sessionKey: "test-key",
  sessionFile: "/tmp/session.json",
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30000,
  runId: "run-1",
} as const;
