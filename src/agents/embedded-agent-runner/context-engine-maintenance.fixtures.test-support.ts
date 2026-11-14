import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { SessionManager } from "../sessions/session-manager.js";

export function createMaintenanceEngine(
  maintain: NonNullable<ContextEngine["maintain"]>,
  overrides: Partial<ContextEngine> = {},
): ContextEngine {
  return {
    info: { id: "test", name: "Test Engine" },
    ingest: async () => ({ ingested: true }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    maintain,
    ...overrides,
  };
}

export function createMaintenanceGate() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered,
    release,
    [Symbol.dispose]: release.resolve,
    async run<T>(finish: () => T) {
      entered.resolve();
      await release.promise;
      return finish();
    },
  };
}

export function createBackgroundMaintenanceEngine(
  maintain: NonNullable<ContextEngine["maintain"]>,
  id = "test",
): ContextEngine & { started: Promise<void> } {
  const started = createDeferred();
  return {
    started: started.promise,
    ...createMaintenanceEngine(
      (params) => {
        started.resolve();
        return maintain(params);
      },
      { info: { id, name: "Test Engine", turnMaintenanceMode: "background" } },
    ),
  };
}

export function createMaintenanceSessionManagerOpenFixture() {
  const openAsync = vi.fn(async (target: SessionTranscriptRuntimeTarget) => {
    const manager = SessionManager.inMemory();
    vi.spyOn(manager, "getSessionTarget").mockReturnValue(target);
    vi.spyOn(manager, "getSessionId").mockReturnValue(target.sessionId);
    return manager;
  });
  return {
    openAsync,
    reset() {
      openAsync.mockClear();
    },
  };
}
