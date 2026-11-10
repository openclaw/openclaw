CREATE TABLE openclaw_id_node_targets (
  hostname TEXT NOT NULL PRIMARY KEY,
  claw_id TEXT NOT NULL,
  root_fingerprint TEXT NOT NULL,
  binding_sequence INTEGER NOT NULL,
  snapshot_sequence INTEGER NOT NULL,
  snapshot_issued_at INTEGER NOT NULL,
  snapshot_binding_sequence INTEGER NOT NULL,
  enrollment_id TEXT,
  discovery_origin TEXT,
  relay_url TEXT,
  server_key TEXT,
  peer_key TEXT,
  evidence_json TEXT,
  CHECK (binding_sequence >= 1 AND snapshot_sequence >= 0 AND snapshot_issued_at >= 0
    AND snapshot_binding_sequence >= 1),
  CHECK ((enrollment_id IS NULL AND discovery_origin IS NULL AND relay_url IS NULL
    AND server_key IS NULL AND peer_key IS NULL AND evidence_json IS NULL)
    OR (enrollment_id IS NOT NULL AND discovery_origin IS NOT NULL AND relay_url IS NOT NULL
    AND server_key IS NOT NULL AND peer_key IS NOT NULL AND evidence_json IS NOT NULL))
) STRICT;
PRAGMA user_version = 1;
