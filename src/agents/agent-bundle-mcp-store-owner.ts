import {
  sessionMcpStoreSourceKey,
  type SessionMcpStoreSource,
} from "../config/sessions/session-mcp-store-admission.js";

type Owner = {
  firstAdmission: number;
  installed: number;
  releasedThrough: number;
  pending: number;
};
type Group = {
  owners: Map<string, Owner>;
  pending: number;
  unknown: boolean;
  released: boolean;
};

/** Runtime keys can be shared across stores. Only positive admissions can release them. */
export function createSessionMcpStoreClaims(maxOwners: number) {
  const groups = new Map<string, Group>();
  let sequence = 0;
  const ready = (group: Group) =>
    group.released && !group.unknown && !group.owners.size && !group.pending;
  return {
    begin(sessionId: string, source: string | undefined) {
      const group: Group = groups.get(sessionId) ?? {
        owners: new Map(),
        pending: 0,
        unknown: false,
        released: false,
      };
      groups.set(sessionId, group);
      const admitted = ++sequence;
      group.pending++;
      let owner = source === undefined ? undefined : group.owners.get(source);
      if (source !== undefined && !owner && !group.unknown && group.owners.size < maxOwners) {
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
      const owners = group.owners;
      return (source: SessionMcpStoreSource) => {
        if (groups.get(sessionId) !== group || group.owners !== owners || group.unknown) {
          return false;
        }
        const key = sessionMcpStoreSourceKey(source);
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
          // A fresh owner map invalidates captures from before the close. Queued installations
          // still need their original claims when they settle.
          const pendingOwners = new Map<string, Owner>();
          for (const [key, owner] of group.owners) {
            if (owner.pending) {
              owner.installed = 0;
              pendingOwners.set(key, owner);
            }
          }
          group.owners.clear();
          group.owners = pendingOwners;
          group.unknown = false;
          group.released = false;
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
