import { vi } from "vitest";

const mockedSessionLikelyHasOversizedToolResults = vi.fn(() => false);
const mockedResolveLiveToolResultMaxChars = vi.fn(() => 32_000);
type MockTruncateOversizedToolResultsResult = {
  truncated: boolean;
  truncatedCount: number;
  reason?: string;
};
const mockedTruncateOversizedToolResultsInSession = vi.fn<
  () => MockTruncateOversizedToolResultsResult
>(() => ({
  truncated: false,
  truncatedCount: 0,
  reason: "no oversized tool results",
}));

export function resetOverflowToolResultMocks() {
  mockedSessionLikelyHasOversizedToolResults.mockReset();
  mockedSessionLikelyHasOversizedToolResults.mockReturnValue(false);
  mockedResolveLiveToolResultMaxChars.mockReset();
  mockedResolveLiveToolResultMaxChars.mockReturnValue(32_000);
  mockedTruncateOversizedToolResultsInSession.mockReset();
  mockedTruncateOversizedToolResultsInSession.mockReturnValue({
    truncated: false,
    truncatedCount: 0,
    reason: "no oversized tool results",
  });
}

export async function createOverflowToolResultMock() {
  const { restoreCacheTtlToolResultProjections } = await vi.importActual<
    typeof import("./tool-result-truncation.js")
  >("./tool-result-truncation.js");
  return {
    restoreCacheTtlToolResultProjections,
    resolveLiveToolResultMaxChars: mockedResolveLiveToolResultMaxChars,
    sessionLikelyHasOversizedToolResults: mockedSessionLikelyHasOversizedToolResults,
    truncateOversizedToolResultsInSessionManager: mockedTruncateOversizedToolResultsInSession,
  };
}
