PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS agencyu_leads (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  ghl_contact_id TEXT,
  manychat_contact_id TEXT,
  instagram_handle TEXT,
  email TEXT,
  phone TEXT,

  stage TEXT NOT NULL,                 -- new | qualified | booked | no_show | closed | nurture
  revenue_tier TEXT,                   -- under_5k | 5k_15k | 15k_50k | 50k_plus
  pain_point TEXT,                     -- acquisition | operations | team | all
  source TEXT,                         -- meta_ad | organic_reel | story_reply | click_to_dm
  campaign TEXT,                       -- utm_campaign string
  engaged_flags TEXT,                  -- JSON list

  appointment_ts TEXT,
  attribution_json TEXT,               -- JSON blob (utm/ad/post/keyword etc.)

  last_touch_ts TEXT,
  last_touch_channel TEXT,
  last_touch_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_agencyu_leads_ghl_contact_id ON agencyu_leads(ghl_contact_id);
CREATE INDEX IF NOT EXISTS idx_agencyu_leads_manychat_contact_id ON agencyu_leads(manychat_contact_id);
CREATE INDEX IF NOT EXISTS idx_agencyu_leads_campaign ON agencyu_leads(campaign);
CREATE INDEX IF NOT EXISTS idx_agencyu_leads_stage ON agencyu_leads(stage);
