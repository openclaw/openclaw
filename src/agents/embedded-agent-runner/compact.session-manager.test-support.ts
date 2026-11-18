import { vi } from "vitest";
import { sessionManagerReadTranscriptBranch } from "../sessions/session-manager-view-types.js";
import type { SessionManager } from "../sessions/session-manager.js";

export function createCompactionSessionManagerMock(messages: unknown[]) {
  const open = (target: Parameters<typeof SessionManager.open>[0]) => ({
    getSessionTarget: () => ({ ...target }),
    buildSessionContext: vi.fn(() => ({ messages })),
    [sessionManagerReadTranscriptBranch]: () => [],
  });
  return {
    open: vi.fn(open),
    openAsync: vi.fn(async (target: Parameters<typeof SessionManager.openAsync>[0]) =>
      open(target),
    ),
  };
}
