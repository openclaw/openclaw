import { Mock, vi } from "vitest";

export const runCommandWithTimeoutMock: Mock<(...args: unknown[]) => unknown> = vi.fn();
export const scanDirectoryWithSummaryMock: Mock<(...args: unknown[]) => unknown> = vi.fn();
export const fetchWithSsrFGuardMock: Mock<(...args: unknown[]) => unknown> = vi.fn();
export const hasBinaryMock: Mock<(bin: string) => boolean> = vi.fn();

export function runCommandWithTimeoutFromMock(...args: unknown[]) {
  return runCommandWithTimeoutMock(...args);
}

export function fetchWithSsrFGuardFromMock(...args: unknown[]) {
  return fetchWithSsrFGuardMock(...args);
}

export function hasBinaryFromMock(bin: string) {
  return hasBinaryMock(bin);
}

export function scanDirectoryWithSummaryFromMock(...args: unknown[]) {
  return scanDirectoryWithSummaryMock(...args);
}

export async function mockSkillScannerModule(
  importOriginal: () => Promise<typeof import("../security/skill-scanner.js")>,
) {
  const actual = await importOriginal();
  return {
    ...actual,
    scanDirectoryWithSummary: scanDirectoryWithSummaryFromMock,
  };
}
