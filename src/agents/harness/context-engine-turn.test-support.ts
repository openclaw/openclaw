import { vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";

export function createTurnEngine<T extends NonNullable<ContextEngine["commitTurn"]>>(
  commitTurn: T,
  durable = true,
) {
  return {
    info: {
      id: "test",
      name: "Test",
      ...(durable
        ? {
            transcriptSemantics: {
              currentTurnFence: "before-current-turn-entry-v1" as const,
              turnAdvancementIdempotency: "atomic-idempotent-v1" as const,
            },
          }
        : {}),
    },
    ingest: async () => ({ ingested: true }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    commitTurn,
  } satisfies ContextEngine;
}

export function createTurnLease(engine: ContextEngine) {
  return {
    engine,
    effectiveEngine: engine,
    effectiveEngineId: "test",
    effectiveEnginePluginId: undefined,
    degraded: false,
    disposed: false,
    degradedReason: undefined,
    selectForHost: vi.fn(),
    degradeBeforeStart: vi.fn(),
    begin: vi.fn(),
    onDispose: vi.fn(),
    deferDisposalUntil: vi.fn(),
    dispose: vi.fn(async () => undefined),
  } satisfies ContextEngineLogicalTurnLease;
}
