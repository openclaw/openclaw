import { vi } from "vitest";

type MockTruncateOversizedToolResultsResult = {
  truncated: boolean;
  truncatedCount: number;
  reason?: string;
};

export const mockedSessionLikelyHasOversizedToolResults = vi.fn(() => false);
export const mockedResolveLiveToolResultMaxChars = vi.fn(() => 32_000);
export const mockedResolveLiveToolResultAggregateMaxChars = vi.fn(() => 128_000);
export const mockedTruncateOversizedToolResultsInSession = vi.fn<
  () => MockTruncateOversizedToolResultsResult
>(() => ({
  truncated: false,
  truncatedCount: 0,
  reason: "no oversized tool results",
}));

export function resetOverflowToolResultTruncationMocks(): void {
  mockedSessionLikelyHasOversizedToolResults.mockReset();
  mockedSessionLikelyHasOversizedToolResults.mockReturnValue(false);
  mockedResolveLiveToolResultMaxChars.mockReset();
  mockedResolveLiveToolResultMaxChars.mockReturnValue(32_000);
  mockedResolveLiveToolResultAggregateMaxChars.mockReset();
  mockedResolveLiveToolResultAggregateMaxChars.mockReturnValue(128_000);
  mockedTruncateOversizedToolResultsInSession.mockReset();
  mockedTruncateOversizedToolResultsInSession.mockReturnValue({
    truncated: false,
    truncatedCount: 0,
    reason: "no oversized tool results",
  });
}
