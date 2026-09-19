/**
 * Assignment store for the secret-assignment broker.
 *
 * Two implementations share one narrow interface:
 * - `createMemoryAssignmentStore` for tests and hermetic use.
 * - `createKeyedAssignmentStore` on top of the host plugin-state keyed store.
 *
 * Only assignment metadata is stored here: agent id -> { mode, names }. Secret
 * values never pass through this module.
 */
import type { AgentAssignment } from "./assignments.js";
import { normalizeAssignment } from "./assignments.js";

export type AssignmentStore = {
  get(agentId: string): Promise<AgentAssignment>;
  set(agentId: string, assignment: AgentAssignment): Promise<void>;
  /** Snapshot of every agent's assignment, for operator inventory. */
  entries(): Promise<Array<{ agentId: string; assignment: AgentAssignment }>>;
};

/** Minimal shape of the host keyed store this plugin depends on. */
export type KeyedStoreLike = {
  lookup(key: string): Promise<unknown>;
  register(key: string, value: unknown): Promise<void>;
  entries(): Promise<Array<{ key: string; value: unknown }>>;
};

/** In-memory store; deterministic and value-free. */
export function createMemoryAssignmentStore(
  seed: Record<string, AgentAssignment> = {},
): AssignmentStore {
  const map = new Map<string, AgentAssignment>(
    Object.entries(seed).map(([agentId, assignment]) => [agentId, normalizeAssignment(assignment)]),
  );
  return {
    async get(agentId) {
      return normalizeAssignment(map.get(agentId));
    },
    async set(agentId, assignment) {
      map.set(agentId, normalizeAssignment(assignment));
    },
    async entries() {
      return [...map.entries()].map(([agentId, assignment]) => ({
        agentId,
        assignment: normalizeAssignment(assignment),
      }));
    },
  };
}

/** Host-backed store. Values are assignment records, never secret material. */
export function createKeyedAssignmentStore(store: KeyedStoreLike): AssignmentStore {
  return {
    async get(agentId) {
      return normalizeAssignment(await store.lookup(agentId));
    },
    async set(agentId, assignment) {
      await store.register(agentId, normalizeAssignment(assignment));
    },
    async entries() {
      const rows = await store.entries();
      return rows.map((row) => ({
        agentId: row.key,
        assignment: normalizeAssignment(row.value),
      }));
    },
  };
}
