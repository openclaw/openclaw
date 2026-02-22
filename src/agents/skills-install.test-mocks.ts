import { vi } from "vitest";

export const runCommandWithTimeoutMock = vi.fn();
export const scanDirectoryWithSummaryMock = vi.fn();
export const fetchWithSsrFGuardMock = vi.fn();
export const hasBinaryMock = vi.fn();

export function runCommandWithTimeoutFromMock(...args: unknown[]) {
  return runCommandWithTimeoutMock(...args);
}

export function fetchWithSsrFGuardFromMock(...args: unknown[]) {
  return fetchWithSsrFGuardMock(...args);
}

export function hasBinaryFromMock(...args: unknown[]) {
  return hasBinaryMock(...args);
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
