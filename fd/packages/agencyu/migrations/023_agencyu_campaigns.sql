PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                 -- authority | momentum
  utm_campaign TEXT NOT NULL,
  start_ts TEXT,
  end_ts TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_campaigns_type_utm_campaign ON campaigns(type, utm_campaign);

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  ghl_contact_id TEXT,
  manychat_contact_id TEXT,
  lead_id TEXT,
  status TEXT,
  joined_ts TEXT,
  created_at TEXT NOT NULL,

  FOREIGN KEY(campaign_id) REFERENCES campaigns(id),
  FOREIGN KEY(lead_id) REFERENCES agencyu_leads(id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign_id ON campaign_contacts(campaign_id);
