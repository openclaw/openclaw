import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { SESSION_MCP_MAX_LIVE_RUNTIMES } from "./agent-bundle-mcp-runtime-shared.js";

export type SessionMcpStoreSource = {
  agentId: string;
  databaseIdentity: string;
  databaseBirthtime?: string;
};

type Target = { sessionId: string; sessionKey?: string; agentId?: string };
type StoreOwner = SessionMcpStoreSource & { sessionId: string; sessionKey: string };
const admissions = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionMcpStoreAdmissions"),
  () => new WeakMap<object, StoreOwner>(),
);

export function bindSessionMcpStoreOwner(admission: object, owner: StoreOwner | undefined): void {
  if (owner) {
    admissions.set(admission, owner);
  } else {
    admissions.delete(admission);
  }
}

export function inheritSessionMcpStoreOwner(source: object | undefined, target: object): void {
  bindSessionMcpStoreOwner(target, source && admissions.get(source));
}

function sourceKey(source: SessionMcpStoreSource): string {
  return JSON.stringify([
    source.agentId,
    source.databaseIdentity,
    source.databaseBirthtime ?? null,
  ]);
}

export function readSessionMcpStoreOwner(admission: object | undefined, target: Target) {
  const owner = admission && admissions.get(admission);
  return owner &&
    owner.sessionId === target.sessionId &&
    owner.sessionKey === target.sessionKey &&
    (!target.agentId || target.agentId === owner.agentId)
    ? sourceKey(owner)
    : undefined;
}

type Owner = {
  firstAdmission: number;
  installed: number;
  releasedThrough: number;
  pending: number;
};
type Group = {
  owners: Map<string, Owner>;
  generation: number;
  pending: number;
  unknown: boolean;
  released: boolean;
};

/** Runtime keys can be shared across stores. Only positive admissions can release them. */
export function createSessionMcpStoreClaims() {
  const groups = new Map<string, Group>();
  let sequence = 0;
  const ready = (group: Group) =>
    group.released && !group.unknown && !group.owners.size && !group.pending;
  return {
    begin(sessionId: string, source: string | undefined) {
      const group: Group = groups.get(sessionId) ?? {
        owners: new Map(),
        generation: 0,
        pending: 0,
        unknown: false,
        released: false,
      };
      groups.set(sessionId, group);
      const admitted = ++sequence;
      group.pending++;
      let owner = source === undefined ? undefined : group.owners.get(source);
      if (
        source !== undefined &&
        !owner &&
        !group.unknown &&
        group.owners.size < SESSION_MCP_MAX_LIVE_RUNTIMES
      ) {
        owner = { firstAdmission: admitted, installed: 0, releasedThrough: 0, pending: 0 };
        group.owners.set(source, owner);
      }
      if (owner) {
        owner.pending++;
      }
      return (installed: boolean) => {
        group.pending--;
        if (source !== undefined && owner) {
          owner.pending--;
          if (installed && admitted > owner.releasedThrough) {
            // Separate requester partitions can finish in reverse admission order.
            owner.installed = Math.max(owner.installed, admitted);
          }
          if (!owner.installed && !owner.pending && group.owners.get(source) === owner) {
            group.owners.delete(source);
          }
        } else if (installed) {
          // Retain unknown and overflow claims until the ordinary runtime lifecycle closes.
          group.unknown = true;
        }
        if (!group.unknown && !group.released && !group.pending && !group.owners.size) {
          groups.delete(sessionId);
        }
      };
    },
    capture(sessionId: string) {
      const group = groups.get(sessionId);
      if (!group || group.unknown || !group.owners.size) {
        return undefined;
      }
      // A scalar cutoff covers in-flight installs without copying queued callers into each capture.
      const cutoff = sequence;
      const generation = group.generation;
      return (source: SessionMcpStoreSource) => {
        if (groups.get(sessionId) !== group || group.generation !== generation || group.unknown) {
          return false;
        }
        const key = sourceKey(source);
        const owner = group.owners.get(key);
        if (
          !owner ||
          owner.firstAdmission > cutoff ||
          owner.installed > cutoff ||
          cutoff <= owner.releasedThrough
        ) {
          return false;
        }
        owner.releasedThrough = cutoff;
        owner.installed = 0;
        if (!owner.pending) {
          group.owners.delete(key);
        }
        group.released = true;
        return true;
      };
    },
    ready(sessionId: string) {
      const group = groups.get(sessionId);
      return group && ready(group)
        ? () => groups.get(sessionId) === group && ready(group)
        : undefined;
    },
    forget(sessionId?: string) {
      for (const id of sessionId === undefined ? groups.keys() : [sessionId]) {
        const group = groups.get(id);
        if (group?.pending) {
          // Keep successors already queued behind this close; invalidate captures of the old group.
          group.generation++;
          group.unknown = false;
          group.released = false;
          for (const [key, owner] of group.owners) {
            owner.installed = 0;
            if (!owner.pending) {
              group.owners.delete(key);
            }
          }
        } else {
          groups.delete(id);
        }
      }
    },
    prune(live: ReadonlySet<string>, catalogs: ReadonlySet<string>) {
      for (const [id, group] of groups) {
        if (!group.pending && !live.has(id) && !catalogs.has(id)) {
          groups.delete(id);
        }
      }
    },
  };
}
