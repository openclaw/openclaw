/**
 * Database schema types and constants
 */

export type LeadStatus =
  | "new"
  | "qualifying"
  | "qualified"
  | "handed_off"
  | "ignored"
  | "blocked"
  | "rate_limited";

export interface Lead {
  id: number;
  phone_number: string;
  first_contact_at: number;
  last_message_at: number;
  last_bot_reply_at: number | null;
  status: LeadStatus;
  assigned_agent: string | null;
  handed_off_at: number | null;
  blocked_at: number | null;
  blocked_reason: string | null;
  rate_limited_at: number | null;
  rate_limit_count: number;
  rate_limit_window_start: number | null;
  follow_up_sent_at: number | null;
  language: string | null;
  name: string | null;
  location: string | null;
  property_type: string | null;
  ownership: string | null;
  bimonthly_bill: number | null;
  score: string | null;
  panels_quoted: number | null;
  quote_cash: number | null;
  quote_financed: number | null;
  quoted_at: number | null;
  notes: string | null;
  receipt_data: string | null; // JSON blob from CFE parse
  tariff: string | null;
  annual_kwh: number | null;
  custom_fields: string; // JSON blob
  created_at: number;
  updated_at: number;
}

export interface HandoffLog {
  id: number;
  lead_id: number;
  event: string;
  triggered_by: string;
  metadata: string | null; // JSON blob
  timestamp: number;
}

export interface QualificationData {
  name?: string;
  location?: string;
  property_type?: string;
  ownership?: string;
  bimonthly_bill?: number;
  score?: string;
}

export interface QuoteData {
  panels_quoted?: number;
  quote_cash?: number;
  quote_financed?: number;
  quoted_at?: number;
  notes?: string;
}

export interface LeadStats {
  total: number;
  new: number;
  qualifying: number;
  qualified: number;
  handedOff: number;
  ignored: number;
  blocked: number;
  rateLimited: number;
}

export interface GlobalRateLimitRow {
  id: number;
  window_start: number;
  message_count: number;
}

export interface CircuitBreakerRow {
  id: number;
  is_tripped: number; // 0 or 1
  tripped_at: number | null;
  trip_reason: string | null;
  reset_at: number | null;
  total_checks: number;
  total_hits: number;
  window_start: number;
}

export type ExtractionStatus = "pending" | "success" | "failed";

export interface ReceiptExtraction {
  id: number;
  lead_id: number;
  status: ExtractionStatus;
  spawned_at: number;
  completed_at: number | null;
  error: string | null;
  file_size: number | null;
  file_path: string | null;
}

export interface WhatsAppLabel {
  name: string;
  wa_label_id: string;
  color: number;
  created_at: number;
  updated_at: number;
}

export interface StoredMessage {
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  from_me: number; // 0 or 1
  timestamp: number; // epoch seconds
  content: string | null;
  message_type: string | null;
  created_at: number;
}

export const MESSAGES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  sender_jid TEXT,
  from_me INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  content TEXT,
  message_type TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp);
`;

export const SCHEMA_VERSION = 7;

export const CREATE_TABLES_SQL = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

-- Leads table
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT UNIQUE NOT NULL,
  first_contact_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  last_bot_reply_at INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  assigned_agent TEXT,
  handed_off_at INTEGER,
  blocked_at INTEGER,
  blocked_reason TEXT,
  rate_limited_at INTEGER,
  rate_limit_count INTEGER DEFAULT 0,
  rate_limit_window_start INTEGER,
  follow_up_sent_at INTEGER,
  language TEXT,
  name TEXT,
  location TEXT,
  property_type TEXT,
  ownership TEXT,
  bimonthly_bill REAL,
  score TEXT,
  panels_quoted INTEGER,
  quote_cash REAL,
  quote_financed REAL,
  quoted_at INTEGER,
  notes TEXT,
  receipt_data TEXT,
  tariff TEXT,
  annual_kwh REAL,
  custom_fields TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone_number);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_last_message ON leads(last_message_at);

-- Handoff log table
CREATE TABLE IF NOT EXISTS handoff_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  metadata TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE INDEX IF NOT EXISTS idx_handoff_log_lead ON handoff_log(lead_id);
CREATE INDEX IF NOT EXISTS idx_handoff_log_timestamp ON handoff_log(timestamp);

-- Global rate limit (singleton row)
CREATE TABLE IF NOT EXISTS global_rate_limit (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window_start INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);

-- Circuit breaker (singleton row)
CREATE TABLE IF NOT EXISTS circuit_breaker (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  is_tripped INTEGER NOT NULL DEFAULT 0,
  tripped_at INTEGER,
  trip_reason TEXT,
  reset_at INTEGER,
  total_checks INTEGER NOT NULL DEFAULT 0,
  total_hits INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- Receipt extraction tracking
CREATE TABLE IF NOT EXISTS receipt_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  spawned_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  file_size INTEGER,
  file_path TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE INDEX IF NOT EXISTS idx_extractions_lead ON receipt_extractions(lead_id);
CREATE INDEX IF NOT EXISTS idx_extractions_status ON receipt_extractions(status);
CREATE INDEX IF NOT EXISTS idx_extractions_spawned ON receipt_extractions(spawned_at);

-- WhatsApp label name→ID mappings
CREATE TABLE IF NOT EXISTS whatsapp_labels (
  name TEXT PRIMARY KEY,
  wa_label_id TEXT NOT NULL,
  color INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

${MESSAGES_TABLE_DDL}
`;

export const MIGRATE_V1_TO_V2_SQL = `
ALTER TABLE leads ADD COLUMN name TEXT;
ALTER TABLE leads ADD COLUMN property_type TEXT;
ALTER TABLE leads ADD COLUMN ownership TEXT;
ALTER TABLE leads ADD COLUMN bimonthly_bill REAL;
ALTER TABLE leads ADD COLUMN score TEXT;
ALTER TABLE leads ADD COLUMN panels_quoted INTEGER;
ALTER TABLE leads ADD COLUMN quote_cash REAL;
ALTER TABLE leads ADD COLUMN quote_financed REAL;
ALTER TABLE leads ADD COLUMN quoted_at INTEGER;
ALTER TABLE leads ADD COLUMN notes TEXT;
`;

export const MIGRATE_V2_TO_V3_DDL = `
CREATE TABLE IF NOT EXISTS global_rate_limit (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window_start INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS circuit_breaker (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  is_tripped INTEGER NOT NULL DEFAULT 0,
  tripped_at INTEGER,
  trip_reason TEXT,
  reset_at INTEGER,
  total_checks INTEGER NOT NULL DEFAULT 0,
  total_hits INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
`;

export const MIGRATE_V2_TO_V3_SEED_GLOBAL = `INSERT OR IGNORE INTO global_rate_limit (id, window_start, message_count) VALUES (1, ?, 0)`;
export const MIGRATE_V2_TO_V3_SEED_BREAKER = `INSERT OR IGNORE INTO circuit_breaker (id, is_tripped, window_start) VALUES (1, 0, ?)`;

export const MIGRATE_V3_TO_V4_DDL = `
CREATE TABLE IF NOT EXISTS receipt_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  spawned_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  file_size INTEGER,
  file_path TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE INDEX IF NOT EXISTS idx_extractions_lead ON receipt_extractions(lead_id);
CREATE INDEX IF NOT EXISTS idx_extractions_status ON receipt_extractions(status);
CREATE INDEX IF NOT EXISTS idx_extractions_spawned ON receipt_extractions(spawned_at);
`;

export const MIGRATE_V4_TO_V5_DDL = `
CREATE TABLE IF NOT EXISTS whatsapp_labels (
  name TEXT PRIMARY KEY,
  wa_label_id TEXT NOT NULL,
  color INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export const MIGRATE_V5_TO_V6_DDL = `
ALTER TABLE leads ADD COLUMN receipt_data TEXT;
ALTER TABLE leads ADD COLUMN tariff TEXT;
ALTER TABLE leads ADD COLUMN annual_kwh REAL;
`;

export const MIGRATE_V5_TO_V6_TABLES = `
CREATE TABLE IF NOT EXISTS receipt_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  spawned_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  file_size INTEGER,
  file_path TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE INDEX IF NOT EXISTS idx_extractions_lead ON receipt_extractions(lead_id);
CREATE INDEX IF NOT EXISTS idx_extractions_status ON receipt_extractions(status);
CREATE INDEX IF NOT EXISTS idx_extractions_spawned ON receipt_extractions(spawned_at);
`;

export const MIGRATE_V6_TO_V7_DDL = MESSAGES_TABLE_DDL;
