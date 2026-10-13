import { vi } from "vitest";
import type { SessionManager } from "../sessions/session-manager.js";

export function createCompactionSessionManagerMock(messages: unknown[]) {
  const createView = (target: Parameters<typeof SessionManager.openAsync>[0]) => ({
    getSessionTarget: () => ({ ...target }),
    buildSessionContext: vi.fn(() => ({ messages })),
  });
  return {
    openAsync: vi.fn(async (target: Parameters<typeof SessionManager.openAsync>[0]) =>
      createView(target),
    ),
  };
}
