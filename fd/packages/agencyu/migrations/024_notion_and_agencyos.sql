-- 024: Notion AgencyOS tables (bindings, id_map, work_order_mirror, attribution_snapshot, clickfunnels_events)

CREATE TABLE IF NOT EXISTS notion_bindings (
  id TEXT PRIMARY KEY,
  binding_type TEXT NOT NULL,
  notion_object_id TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(binding_type, notion_object_id)
);

CREATE TABLE IF NOT EXISTS id_map (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  external_id TEXT NOT NULL,
  notion_page_id TEXT,
  ghl_contact_id TEXT,
  trello_card_id TEXT,
  manychat_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(domain, external_id)
);
CREATE INDEX IF NOT EXISTS idx_id_map_notion ON id_map(notion_page_id);
CREATE INDEX IF NOT EXISTS idx_id_map_ghl ON id_map(ghl_contact_id);

CREATE TABLE IF NOT EXISTS work_order_mirror (
  id TEXT PRIMARY KEY,
  trello_card_id TEXT NOT NULL,
  notion_page_id TEXT,
  board_id TEXT,
  status TEXT NOT NULL,
  title TEXT,
  assigned_to TEXT,
  due_date TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(trello_card_id)
);
CREATE INDEX IF NOT EXISTS idx_wom_notion ON work_order_mirror(notion_page_id);
CREATE INDEX IF NOT EXISTS idx_wom_status ON work_order_mirror(status);

CREATE TABLE IF NOT EXISTS attribution_snapshot (
  id TEXT PRIMARY KEY,
  contact_key TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  first_touch_ts TEXT,
  last_touch_ts TEXT,
  manychat_user_id TEXT,
  ghl_contact_id TEXT,
  stripe_payment_id TEXT,
  revenue_cents INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attr_snap_contact ON attribution_snapshot(contact_key);
CREATE INDEX IF NOT EXISTS idx_attr_snap_campaign ON attribution_snapshot(utm_campaign);

CREATE TABLE IF NOT EXISTS clickfunnels_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  funnel_id TEXT,
  page_id TEXT,
  email TEXT,
  name TEXT,
  phone TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  payload_json TEXT NOT NULL,
  correlation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cf_events_email ON clickfunnels_events(email);
CREATE INDEX IF NOT EXISTS idx_cf_events_type ON clickfunnels_events(event_type);
