export const SCHEMA = `
CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gateway_url TEXT NOT NULL,
  gateway_token TEXT NOT NULL,
  bridge_url TEXT NOT NULL,
  container_id TEXT,
  device_credentials TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_name TEXT,
  credentials TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  UNIQUE(provider, external_id)
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT,
  connection_id TEXT,
  provider TEXT NOT NULL,
  external_id TEXT,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  response_status INTEGER,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
`;
