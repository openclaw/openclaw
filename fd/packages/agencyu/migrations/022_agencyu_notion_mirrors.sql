PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS notion_mirrors (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  mirror_type TEXT NOT NULL,          -- lead | client | work_order
  ghl_contact_id TEXT,
  lead_id TEXT,
  client_id TEXT,

  notion_page_id TEXT NOT NULL,
  notion_db_id TEXT,
  last_sync_at TEXT,
  last_error TEXT,

  UNIQUE(mirror_type, notion_page_id)
);

CREATE INDEX IF NOT EXISTS idx_notion_mirrors_ghl_contact_id ON notion_mirrors(ghl_contact_id);
CREATE INDEX IF NOT EXISTS idx_notion_mirrors_lead_id ON notion_mirrors(lead_id);
