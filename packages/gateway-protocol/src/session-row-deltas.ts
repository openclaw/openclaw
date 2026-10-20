/** Shared count bound keeps the socket's server/client row LRU deterministic. */
export const SESSION_ROW_DELTA_MAX_ENTRIES = 1_024;

export function sessionRowIdentity(key: string, agentId?: string): string {
  return JSON.stringify([agentId, key]);
}

type SessionRowWireIdentity = {
  key: string;
  agentId?: string;
  version: number;
};

export type SessionRowFull = SessionRowWireIdentity & {
  full: Record<string, unknown>;
  retain?: false;
};

export type SessionRowPatch = SessionRowWireIdentity & {
  base: number;
  set: Record<string, unknown>;
  remove: string[];
};

export type SessionRowWire = SessionRowFull | SessionRowPatch;
