import type { Generated } from "openclaw/plugin-sdk/sqlite-worker-runtime";

/** Kysely shapes of the per-store operational database tables queried through the builder. */
export type StorageTables = {
  identities: { agent_key: string; manifest: string };
  mutations: {
    rowid: Generated<number>;
    scope: string;
    request: string;
    intent: string;
    state: string;
    plan: string;
    receipt: string;
  };
  history: {
    sequence: Generated<number>;
    scope: string;
    id: string;
    provenance: string;
    at: string;
    path: string;
    revision: number;
    hash: string;
    raw: string;
    agent_id: string | null;
  };
  observations: {
    scope: string;
    id: string;
    path: string;
    hash: string;
    revision: number;
    raw: string;
  };
  git_jobs: {
    sequence: Generated<number>;
    scope: string;
    token: string;
    batch: string;
    state: string;
    commit_id: string | null;
    message: string;
  };
  git_files: { scope: string; path: string; hash: string };
  keyword_withdrawals_v1: { binding: string; id: string };
  keyword_state_v1: { binding: string; snapshot: string; indexed_at: string };
  temporal_entities_v1: { binding: string; id: string; entity: string };
  session_activity: {
    sequence: Generated<number>;
    scope: string;
    agent_id: string;
    session_key: string;
    session_id: string;
    call_id: string;
    operation: string;
    action: string;
    at: string;
    record_id: string;
    revision: number;
  };
  recent_requests_v1: {
    scope: string;
    request: string;
    operation: string | null;
    target_id: string | null;
    at: string | null;
    reason: string | null;
    replacement_id: string | null;
  };
  recent_records_v1: {
    scope: string;
    request: string;
    ordinal: number;
    id: string | null;
    hash: string | null;
    revision: bigint | number | string | null;
    actor: string | null;
    kind: string | null;
    type: string | null;
    title: string | null;
  };
};
