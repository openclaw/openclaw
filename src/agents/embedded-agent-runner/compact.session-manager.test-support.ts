import { vi } from "vitest";
import type { SessionManager } from "../sessions/session-manager.js";

export function createCompactionSessionManagerMock(messages: unknown[]) {
  const open = (target: Parameters<typeof SessionManager.open>[0]) => ({
    getSessionTarget: () => ({ ...target }),
    buildSessionContext: vi.fn(() => ({ messages })),
  });
  return {
    open: vi.fn(open),
    openAsync: vi.fn(async (target: Parameters<typeof SessionManager.openAsync>[0]) =>
      open(target),
    ),
  };
}

/** In-memory hook fixtures have no durable history source; delegates exercise the real path. */
export function configureCompactionSessionMode(durable: boolean): void {
  if (durable) {
    vi.doUnmock("./bounded-compaction-session.js");
    vi.doUnmock("./server-endpoint-compaction.js");
    vi.doUnmock("../sessions/model-registry-runtime.js");
    vi.doUnmock("../sessions/resource-loader.js");
    vi.doUnmock("../sessions/index.js");
    vi.doUnmock("../sessions/sdk.js");
    vi.doUnmock("../session-tool-result-guard-wrapper.js");
    vi.doUnmock("../agent-settings.js");
    vi.doUnmock("../agent-project-settings.js");
    return;
  }
  vi.doMock("./bounded-compaction-session.js", async () => ({
    ...(await vi.importActual<typeof import("./bounded-compaction-session.js")>(
      "./bounded-compaction-session.js",
    )),
    usesBoundedCompactionSource: () => false,
  }));
}
