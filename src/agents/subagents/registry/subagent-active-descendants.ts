import { readAgentRunIndexVersion } from "../../../infra/agent-run-registry-state.js";
import { readSwarmReservationRevision } from "../swarm/swarm-scheduler.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import { isSameSubagentRun } from "./subagent-run-generation.js";
import { getSubagentRunStaleAt, hasSubagentRunEnded } from "./subagent-run-liveness.js";

/** Latest children own ancestor contributions; readers consume the maintained facts. */
export function buildSubagentActiveDescendants<T extends SubagentRunReadRecord>(
  latestRunsByChildSessionKey: ReadonlyMap<string, T>,
  inMemoryDisplayByChildSessionKey: ReadonlyMap<string, T>,
  isRetainedReadRun: (entry: T, clock: number) => boolean,
  now: number,
) {
  type Contribution = { roots: string[]; active: number };
  const contributions = new Map<string, Contribution>();
  const activeByRoot = new Map<
    string,
    { count: number; dynamic: Map<string, number>; nextChange: number }
  >();
  const activeRequesters = new Set<string>();
  const dynamic = new Set<string>();
  const dirtyBoundaries = new Set<string>();
  let initialized = false;
  let activeClock = now;
  let nextChange = Infinity;
  let liveRevision = -1;
  let reservationRevision = -1;
  const staleBoundary = (entry: T, clock: number): number => {
    const staleAt = getSubagentRunStaleAt(entry);
    return staleAt >= clock ? staleAt : Infinity;
  };
  function repairChild(child: string, clock: number) {
    const contribution = contributions.get(child);
    const entry = latestRunsByChildSessionKey.get(child);
    if (!contribution || !entry) {
      return;
    }
    const active = Number(isRetainedReadRun(entry, clock));
    const unended = !hasSubagentRunEnded(entry);
    let boundary = staleBoundary(entry, clock);
    const current = inMemoryDisplayByChildSessionKey.get(child);
    if (unended && current && isSameSubagentRun(current, entry)) {
      boundary = Math.min(boundary, staleBoundary(current, clock));
    }
    for (const root of contribution.roots) {
      let state = activeByRoot.get(root);
      if (!state) {
        activeByRoot.set(root, (state = { count: 0, dynamic: new Map(), nextChange: Infinity }));
      }
      state.count += active - contribution.active;
      const previous = state.dynamic.get(child);
      if (unended) {
        state.dynamic.set(child, boundary);
      } else {
        state.dynamic.delete(child);
      }
      if (previous === state.nextChange && boundary > previous) {
        dirtyBoundaries.add(root);
      } else {
        state.nextChange = Math.min(state.nextChange, boundary);
      }
      if (state.count) {
        activeRequesters.add(root);
      } else {
        activeRequesters.delete(root);
      }
    }
    contribution.active = active;
    if (unended) {
      dynamic.add(child);
      nextChange = Math.min(nextChange, boundary);
    } else {
      dynamic.delete(child);
    }
  }
  function prepareActive(clock: number) {
    const live = readAgentRunIndexVersion();
    const reservations = readSwarmReservationRevision();
    if (!initialized) {
      // Each latest child contributes once to each ancestor, including cycles.
      // Topology changes replace links; status patches repair only that child's contributions.
      for (const [child, entry] of latestRunsByChildSessionKey) {
        const roots = new Set<string>();
        let root = entry.requesterSessionKey;
        while (root && !roots.has(root)) {
          roots.add(root);
          root = latestRunsByChildSessionKey.get(root)?.requesterSessionKey ?? "";
        }
        contributions.set(child, { roots: [...roots], active: 0 });
        repairChild(child, clock);
      }
      initialized = true;
    } else if (
      clock < activeClock ||
      clock > nextChange ||
      live !== liveRevision ||
      reservations !== reservationRevision
    ) {
      // Grace expiry and live ownership can change without a registry row patch.
      nextChange = Infinity;
      for (const child of dynamic) {
        repairChild(child, clock);
      }
    }
    if (dirtyBoundaries.size) {
      for (const root of dirtyBoundaries) {
        const state = activeByRoot.get(root)!;
        state.nextChange = Infinity;
        for (const pending of state.dynamic.values()) {
          state.nextChange = Math.min(state.nextChange, pending);
        }
      }
      dirtyBoundaries.clear();
    }
    activeClock = clock;
    liveRevision = live;
    reservationRevision = reservations;
  }

  return {
    activeByRoot,
    activeRequesters,
    prepare: prepareActive,
    patch(affected: Iterable<string>, membershipChanged: boolean, clock: number) {
      if (initialized) {
        if (membershipChanged) {
          contributions.clear();
          activeByRoot.clear();
          activeRequesters.clear();
          dynamic.clear();
          dirtyBoundaries.clear();
          nextChange = Infinity;
          initialized = false;
        } else {
          for (const child of affected) {
            repairChild(child, clock);
          }
        }
        prepareActive(clock);
      }
    },
  };
}
