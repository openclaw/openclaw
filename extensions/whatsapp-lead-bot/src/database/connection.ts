/**
 * SQLite database implementation
 */

import Database from "better-sqlite3";
import type { Database as DatabaseInterface } from "../database.js";
import { normalizePhone } from "../utils/phone.js";
import type {
  Lead,
  LeadStatus,
  QualificationData,
  QuoteData,
  LeadStats,
  GlobalRateLimitRow,
  CircuitBreakerRow,
  ReceiptExtraction,
  ExtractionStatus,
  WhatsAppLabel,
  StoredMessage,
} from "./schema.js";
import {
  CREATE_TABLES_SQL,
  MIGRATE_V1_TO_V2_SQL,
  MIGRATE_V2_TO_V3_DDL,
  MIGRATE_V2_TO_V3_SEED_GLOBAL,
  MIGRATE_V2_TO_V3_SEED_BREAKER,
  MIGRATE_V3_TO_V4_DDL,
  MIGRATE_V4_TO_V5_DDL,
  MIGRATE_V5_TO_V6_DDL,
  MIGRATE_V5_TO_V6_TABLES,
  MIGRATE_V6_TO_V7_DDL,
  SCHEMA_VERSION,
} from "./schema.js";

export interface SqliteDatabaseConfig {
  dbPath: string;
}

export class SqliteDatabase implements DatabaseInterface {
  private db: Database.Database;

  constructor(private config: SqliteDatabaseConfig) {
    this.db = new Database(config.dbPath);
    this.db.pragma("journal_mode = DELETE");
    this.db.pragma("foreign_keys = ON");
  }

  migrate(): void {
    // Execute schema (creates tables if they don't exist)
    this.db.exec(CREATE_TABLES_SQL);

    // Check/update schema version
    const versionRow = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;

    if (!versionRow) {
      // Fresh database — seed singleton rows
      const now = Date.now();
      this.db.prepare(MIGRATE_V2_TO_V3_SEED_GLOBAL).run(now);
      this.db.prepare(MIGRATE_V2_TO_V3_SEED_BREAKER).run(now);
      this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    } else if (versionRow.version < SCHEMA_VERSION) {
      if (versionRow.version < 2) {
        // v1→v2: add SOLAYRE columns (each ALTER TABLE individually — SQLite limitation)
        for (const stmt of MIGRATE_V1_TO_V2_SQL.split(";")) {
          const trimmed = stmt.trim();
          if (trimmed) {
            try {
              this.db.exec(trimmed);
            } catch (err: unknown) {
              // Ignore "duplicate column name" — column already exists
              if (!(err instanceof Error && err.message.includes("duplicate column"))) {
                throw err;
              }
            }
          }
        }
      }
      if (versionRow.version < 3) {
        // v2→v3: add global rate limit + circuit breaker tables
        this.db.exec(MIGRATE_V2_TO_V3_DDL);
        const now = Date.now();
        this.db.prepare(MIGRATE_V2_TO_V3_SEED_GLOBAL).run(now);
        this.db.prepare(MIGRATE_V2_TO_V3_SEED_BREAKER).run(now);
      }
      if (versionRow.version < 4) {
        // v3→v4: add receipt_extractions table
        this.db.exec(MIGRATE_V3_TO_V4_DDL);
      }
      if (versionRow.version < 5) {
        // v4→v5: add whatsapp_labels table
        this.db.exec(MIGRATE_V4_TO_V5_DDL);
      }
      if (versionRow.version < 6) {
        // v5→v6: add receipt columns to leads + receipt_extractions table
        for (const stmt of MIGRATE_V5_TO_V6_DDL.split(";")) {
          const trimmed = stmt.trim();
          if (trimmed) {
            try {
              this.db.exec(trimmed);
            } catch (err: unknown) {
              if (!(err instanceof Error && err.message.includes("duplicate column"))) {
                throw err;
              }
            }
          }
        }
        this.db.exec(MIGRATE_V5_TO_V6_TABLES);
      }
      if (versionRow.version < 7) {
        // v6→v7: add messages table
        this.db.exec(MIGRATE_V6_TO_V7_DDL);
      }
      this.db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
    }
  }

  close(): void {
    this.db.close();
  }

  async getOrCreateLead(phoneNumber: string): Promise<Lead> {
    const existing = await this.getLeadByPhone(phoneNumber);
    if (existing) {
      return existing;
    }

    // Store original phone (e.g. +5216691590605) — normalizePhone is for
    // lookups only; the stored value must be usable as a send target.
    const now = Date.now();
    const result = this.db
      .prepare(`
      INSERT INTO leads (
        phone_number, first_contact_at, last_message_at,
        status, custom_fields, created_at, updated_at
      ) VALUES (?, ?, ?, 'new', '{}', ?, ?)
    `)
      .run(phoneNumber, now, now, now, now);

    return this.getLeadById(result.lastInsertRowid as number) as Promise<Lead>;
  }

  async getLeadById(id: number): Promise<Lead | null> {
    const row = this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as Lead | undefined;
    return row || null;
  }

  async getLeadByPhone(phoneNumber: string): Promise<Lead | null> {
    // Try exact match first, then normalized — so admin commands work
    // regardless of whether the user types +521, 52, or the full number.
    const normalized = normalizePhone(phoneNumber);
    const row = this.db
      .prepare("SELECT * FROM leads WHERE phone_number = ? OR phone_number = ?")
      .get(phoneNumber, normalized) as Lead | undefined;
    return row || null;
  }

  async updateLeadStatus(id: number, status: LeadStatus): Promise<void> {
    const now = Date.now();
    this.db
      .prepare("UPDATE leads SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);

    if (status === "handed_off") {
      this.db.prepare("UPDATE leads SET handed_off_at = ? WHERE id = ?").run(now, id);
    } else if (status === "blocked") {
      this.db.prepare("UPDATE leads SET blocked_at = ? WHERE id = ?").run(now, id);
    } else if (status === "rate_limited") {
      this.db.prepare("UPDATE leads SET rate_limited_at = ? WHERE id = ?").run(now, id);
    }
  }

  async updateLeadTimestamp(id: number, timestamp: number): Promise<void> {
    this.db
      .prepare("UPDATE leads SET last_message_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, Date.now(), id);
  }

  async updateAssignedAgent(id: number, agentPhone: string | null): Promise<void> {
    this.db
      .prepare("UPDATE leads SET assigned_agent = ?, updated_at = ? WHERE id = ?")
      .run(agentPhone, Date.now(), id);
  }

  async updateLastBotReply(id: number, timestamp: number): Promise<void> {
    this.db
      .prepare("UPDATE leads SET last_bot_reply_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, Date.now(), id);
  }

  async updateQualificationData(leadId: number, data: Partial<QualificationData>): Promise<void> {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) {
      updates.push("name = ?");
      values.push(data.name);
    }
    if (data.location !== undefined) {
      updates.push("location = ?");
      values.push(data.location);
    }
    if (data.property_type !== undefined) {
      updates.push("property_type = ?");
      values.push(data.property_type);
    }
    if (data.ownership !== undefined) {
      updates.push("ownership = ?");
      values.push(data.ownership);
    }
    if (data.bimonthly_bill !== undefined) {
      updates.push("bimonthly_bill = ?");
      values.push(data.bimonthly_bill);
    }
    if (data.score !== undefined) {
      updates.push("score = ?");
      values.push(data.score);
    }

    if (updates.length > 0) {
      updates.push("updated_at = ?");
      values.push(Date.now());
      values.push(leadId);

      this.db.prepare(`UPDATE leads SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    }
  }

  async isLeadQualified(leadId: number): Promise<boolean> {
    const lead = await this.getLeadById(leadId);
    if (!lead) return false;

    return !!(
      lead.name &&
      lead.location &&
      lead.ownership &&
      lead.bimonthly_bill &&
      lead.property_type
    );
  }

  async updateQuoteData(leadId: number, data: Partial<QuoteData>): Promise<void> {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (data.panels_quoted !== undefined) {
      updates.push("panels_quoted = ?");
      values.push(data.panels_quoted);
    }
    if (data.quote_cash !== undefined) {
      updates.push("quote_cash = ?");
      values.push(data.quote_cash);
    }
    if (data.quote_financed !== undefined) {
      updates.push("quote_financed = ?");
      values.push(data.quote_financed);
    }
    if (data.quoted_at !== undefined) {
      updates.push("quoted_at = ?");
      values.push(data.quoted_at);
    }
    if (data.notes !== undefined) {
      updates.push("notes = ?");
      values.push(data.notes);
    }

    if (updates.length > 0) {
      updates.push("updated_at = ?");
      values.push(Date.now());
      values.push(leadId);

      this.db.prepare(`UPDATE leads SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    }
  }

  async logHandoffEvent(
    leadId: number,
    event: string,
    triggeredBy: string,
    metadata?: unknown,
  ): Promise<void> {
    const metadataJson = metadata ? JSON.stringify(metadata) : null;
    this.db
      .prepare(`
      INSERT INTO handoff_log (lead_id, event, triggered_by, metadata, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `)
      .run(leadId, event, triggeredBy, metadataJson, Date.now());
  }

  async updateRateLimitCount(leadId: number, count: number): Promise<void> {
    this.db
      .prepare("UPDATE leads SET rate_limit_count = ?, updated_at = ? WHERE id = ?")
      .run(count, Date.now(), leadId);
  }

  async updateRateLimitWindow(leadId: number, windowStart: number): Promise<void> {
    this.db
      .prepare("UPDATE leads SET rate_limit_window_start = ?, updated_at = ? WHERE id = ?")
      .run(windowStart, Date.now(), leadId);
  }

  async resetRateLimit(leadId: number): Promise<void> {
    this.db
      .prepare(`
      UPDATE leads
      SET rate_limit_count = 0, rate_limit_window_start = NULL, rate_limited_at = NULL, updated_at = ?
      WHERE id = ?
    `)
      .run(Date.now(), leadId);
  }

  async blockLead(leadId: number, reason: string): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(`
      UPDATE leads
      SET status = 'blocked', blocked_at = ?, blocked_reason = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(now, reason, now, leadId);
  }

  async unblockLead(leadId: number): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(`
      UPDATE leads
      SET status = 'qualifying', blocked_at = NULL, blocked_reason = NULL, updated_at = ?
      WHERE id = ?
    `)
      .run(now, leadId);
  }

  async resetLead(leadId: number): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(`
      UPDATE leads
      SET status = 'qualifying',
          name = NULL, location = NULL, property_type = NULL, ownership = NULL,
          bimonthly_bill = NULL, score = NULL,
          panels_quoted = NULL, quote_cash = NULL, quote_financed = NULL, quoted_at = NULL,
          notes = NULL, assigned_agent = NULL, handed_off_at = NULL,
          blocked_at = NULL, blocked_reason = NULL,
          rate_limit_count = 0, rate_limit_window_start = NULL, rate_limited_at = NULL,
          follow_up_sent_at = NULL,
          receipt_data = NULL, tariff = NULL, annual_kwh = NULL,
          updated_at = ?
      WHERE id = ?
    `)
      .run(now, leadId);
  }

  async getSilentLeads(thresholdHours: number, maxFollowups: number): Promise<Lead[]> {
    const thresholdMs = thresholdHours * 60 * 60 * 1000;
    const cutoff = Date.now() - thresholdMs;

    const rows = this.db
      .prepare(`
      SELECT * FROM leads
      WHERE status = 'qualifying'
        AND last_message_at < ?
        AND (follow_up_sent_at IS NULL OR follow_up_sent_at < ?)
      LIMIT ?
    `)
      .all(cutoff, cutoff, maxFollowups) as Lead[];

    return rows;
  }

  async updateFollowUpSentAt(id: number, timestamp: number): Promise<void> {
    this.db
      .prepare("UPDATE leads SET follow_up_sent_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, Date.now(), id);
  }

  async getStats(): Promise<LeadStats> {
    const row = this.db
      .prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new,
        SUM(CASE WHEN status = 'qualifying' THEN 1 ELSE 0 END) as qualifying,
        SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) as qualified,
        SUM(CASE WHEN status = 'handed_off' THEN 1 ELSE 0 END) as handedOff,
        SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END) as ignored,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked,
        SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rateLimited
      FROM leads
    `)
      .get() as LeadStats;

    return row;
  }

  async getRecentLeads(limit: number): Promise<Lead[]> {
    const rows = this.db
      .prepare(`
      SELECT * FROM leads
      ORDER BY last_message_at DESC
      LIMIT ?
    `)
      .all(limit) as Lead[];

    return rows;
  }

  // --- Global rate limiting ---

  async getGlobalRateLimit(): Promise<GlobalRateLimitRow> {
    return this.db
      .prepare("SELECT * FROM global_rate_limit WHERE id = 1")
      .get() as GlobalRateLimitRow;
  }

  async incrementGlobalCount(): Promise<GlobalRateLimitRow> {
    const txn = this.db.transaction(() => {
      this.db
        .prepare("UPDATE global_rate_limit SET message_count = message_count + 1 WHERE id = 1")
        .run();
      return this.db
        .prepare("SELECT * FROM global_rate_limit WHERE id = 1")
        .get() as GlobalRateLimitRow;
    });
    return txn();
  }

  async resetGlobalWindow(now: number): Promise<void> {
    this.db
      .prepare("UPDATE global_rate_limit SET window_start = ?, message_count = 0 WHERE id = 1")
      .run(now);
  }

  // --- Circuit breaker ---

  async getCircuitBreaker(): Promise<CircuitBreakerRow> {
    return this.db.prepare("SELECT * FROM circuit_breaker WHERE id = 1").get() as CircuitBreakerRow;
  }

  async recordCircuitCheck(wasHit: boolean): Promise<CircuitBreakerRow> {
    const txn = this.db.transaction(() => {
      if (wasHit) {
        this.db
          .prepare(
            "UPDATE circuit_breaker SET total_checks = total_checks + 1, total_hits = total_hits + 1 WHERE id = 1",
          )
          .run();
      } else {
        this.db
          .prepare("UPDATE circuit_breaker SET total_checks = total_checks + 1 WHERE id = 1")
          .run();
      }
      return this.db
        .prepare("SELECT * FROM circuit_breaker WHERE id = 1")
        .get() as CircuitBreakerRow;
    });
    return txn();
  }

  async tripCircuitBreaker(reason: string): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE circuit_breaker SET is_tripped = 1, tripped_at = ?, trip_reason = ? WHERE id = 1",
      )
      .run(now, reason);
  }

  async resetCircuitBreaker(): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE circuit_breaker SET is_tripped = 0, tripped_at = NULL, trip_reason = NULL, reset_at = ?, total_checks = 0, total_hits = 0, window_start = ? WHERE id = 1",
      )
      .run(now, now);
  }

  async resetCircuitWindow(now: number): Promise<void> {
    this.db
      .prepare(
        "UPDATE circuit_breaker SET total_checks = 0, total_hits = 0, window_start = ? WHERE id = 1",
      )
      .run(now);
  }

  // --- Atomic per-lead rate limit ---

  async checkAndRecordMessage(
    leadId: number,
    maxMessages: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; count: number; reason?: string }> {
    const txn = this.db.transaction(() => {
      const lead = this.db
        .prepare("SELECT rate_limit_count, rate_limit_window_start FROM leads WHERE id = ?")
        .get(leadId) as Pick<Lead, "rate_limit_count" | "rate_limit_window_start"> | undefined;

      if (!lead) {
        return { allowed: true, count: 0 };
      }

      const now = Date.now();
      const windowStart = lead.rate_limit_window_start || now;
      const elapsed = now - windowStart;

      // Window expired → reset and allow
      if (elapsed > windowMs || !lead.rate_limit_window_start) {
        this.db
          .prepare(
            "UPDATE leads SET rate_limit_count = 1, rate_limit_window_start = ?, updated_at = ? WHERE id = ?",
          )
          .run(now, now, leadId);
        return { allowed: true, count: 1 };
      }

      // Over limit → deny without incrementing
      if (lead.rate_limit_count >= maxMessages) {
        return {
          allowed: false,
          count: lead.rate_limit_count,
          reason: `Rate limit exceeded: ${lead.rate_limit_count} messages in ${Math.floor(elapsed / 60000)} minutes`,
        };
      }

      // Under limit → increment and allow
      const newCount = lead.rate_limit_count + 1;
      this.db
        .prepare("UPDATE leads SET rate_limit_count = ?, updated_at = ? WHERE id = ?")
        .run(newCount, now, leadId);

      return { allowed: true, count: newCount };
    });

    return txn();
  }

  // --- Receipt extraction tracking ---

  async createExtractionRecord(
    leadId: number,
    fileSize: number | null,
    filePath: string | null,
  ): Promise<number> {
    const now = Date.now();
    const result = this.db
      .prepare(
        "INSERT INTO receipt_extractions (lead_id, status, spawned_at, file_size, file_path) VALUES (?, 'pending', ?, ?, ?)",
      )
      .run(leadId, now, fileSize, filePath);
    return result.lastInsertRowid as number;
  }

  async updateExtractionStatus(
    extractionId: number,
    status: ExtractionStatus,
    error: string | null = null,
  ): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE receipt_extractions SET status = ?, completed_at = ?, error = ? WHERE id = ?",
      )
      .run(status, now, error, extractionId);
  }

  async getExtractionAttempts(leadId: number): Promise<ReceiptExtraction[]> {
    return this.db
      .prepare("SELECT * FROM receipt_extractions WHERE lead_id = ? ORDER BY spawned_at DESC")
      .all(leadId) as ReceiptExtraction[];
  }

  async getPendingExtraction(leadId: number): Promise<ReceiptExtraction | null> {
    return (
      (this.db
        .prepare(
          "SELECT * FROM receipt_extractions WHERE lead_id = ? AND status = 'pending' ORDER BY spawned_at DESC LIMIT 1",
        )
        .get(leadId) as ReceiptExtraction | undefined) || null
    );
  }

  async updateCustomFields(leadId: number, fields: Record<string, unknown>): Promise<void> {
    const lead = await this.getLeadById(leadId);
    const existing = lead?.custom_fields ? JSON.parse(lead.custom_fields as string) : {};
    const merged = { ...existing, ...fields };
    this.db
      .prepare("UPDATE leads SET custom_fields = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(merged), Date.now(), leadId);
  }

  async upsertLead(
    phone: string,
    data: Partial<
      import("./schema.js").QualificationData & import("./schema.js").QuoteData & { notes: string }
    >,
  ): Promise<import("./schema.js").Lead> {
    const normalizedPhone = normalizePhone(phone);
    const existing = await this.getLeadByPhone(normalizedPhone);
    const now = Date.now();

    if (existing) {
      // Update only provided fields
      const updates: string[] = [];
      const values: unknown[] = [];

      if (data.name !== undefined) {
        updates.push("name = ?");
        values.push(data.name);
      }
      if (data.location !== undefined) {
        updates.push("location = ?");
        values.push(data.location);
      }
      if (data.property_type !== undefined) {
        updates.push("property_type = ?");
        values.push(data.property_type);
      }
      if (data.ownership !== undefined) {
        updates.push("ownership = ?");
        values.push(data.ownership);
      }
      if (data.bimonthly_bill !== undefined) {
        updates.push("bimonthly_bill = ?");
        values.push(data.bimonthly_bill);
      }
      if (data.score !== undefined) {
        updates.push("score = ?");
        values.push(data.score);
      }
      if (data.panels_quoted !== undefined) {
        updates.push("panels_quoted = ?");
        values.push(data.panels_quoted);
      }
      if (data.quote_cash !== undefined) {
        updates.push("quote_cash = ?");
        values.push(data.quote_cash);
      }
      if (data.quote_financed !== undefined) {
        updates.push("quote_financed = ?");
        values.push(data.quote_financed);
      }
      if (data.quoted_at !== undefined) {
        updates.push("quoted_at = ?");
        values.push(data.quoted_at);
      }
      if (data.notes !== undefined) {
        updates.push("notes = ?");
        values.push(data.notes);
      }

      if (updates.length > 0) {
        updates.push("updated_at = ?");
        values.push(now);
        values.push(existing.id);
        this.db.prepare(`UPDATE leads SET ${updates.join(", ")} WHERE id = ?`).run(...values);
      }

      return (await this.getLeadById(existing.id))!;
    }

    // Insert new lead
    const result = this.db
      .prepare(`
      INSERT INTO leads (
        phone_number, name, location, property_type, ownership, bimonthly_bill,
        score, panels_quoted, quote_cash, quote_financed, notes,
        status, custom_fields, first_contact_at, last_message_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', '{}', ?, ?, ?, ?)
    `)
      .run(
        normalizedPhone,
        data.name ?? null,
        data.location ?? null,
        data.property_type ?? null,
        data.ownership ?? null,
        data.bimonthly_bill ?? null,
        data.score ?? null,
        data.panels_quoted ?? null,
        data.quote_cash ?? null,
        data.quote_financed ?? null,
        data.notes ?? null,
        now,
        now,
        now,
        now,
      );

    return (await this.getLeadById(result.lastInsertRowid as number))!;
  }

  async listLeads(filters?: { status?: string; score?: string }): Promise<Lead[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters?.status) {
      conditions.push("status = ?");
      values.push(filters.status);
    }
    if (filters?.score) {
      conditions.push("score = ?");
      values.push(filters.score);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM leads ${where} ORDER BY last_message_at DESC`)
      .all(...values) as Lead[];
  }

  async updateReceiptData(
    leadId: number,
    data: { receipt_data: string; tariff?: string; annual_kwh?: number },
  ): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE leads SET receipt_data = ?, tariff = ?, annual_kwh = ?, updated_at = ? WHERE id = ?",
      )
      .run(data.receipt_data, data.tariff ?? null, data.annual_kwh ?? null, now, leadId);
  }

  async getRecentExtractionFailures(windowMs: number): Promise<number> {
    const cutoff = Date.now() - windowMs;
    const result = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM receipt_extractions WHERE status = 'failed' AND spawned_at > ?",
      )
      .get(cutoff) as { count: number } | undefined;
    return result?.count || 0;
  }

  // --- WhatsApp label store ---

  async getLabelId(name: string): Promise<string | null> {
    const row = this.db
      .prepare("SELECT wa_label_id FROM whatsapp_labels WHERE name = ?")
      .get(name) as { wa_label_id: string } | undefined;
    return row?.wa_label_id ?? null;
  }

  async upsertLabel(name: string, waLabelId: string, color: number): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO whatsapp_labels (name, wa_label_id, color, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET wa_label_id = excluded.wa_label_id, color = excluded.color, updated_at = excluded.updated_at`,
      )
      .run(name, waLabelId, color, now, now);
  }

  async getAllLabels(): Promise<WhatsAppLabel[]> {
    return this.db.prepare("SELECT * FROM whatsapp_labels").all() as WhatsAppLabel[];
  }

  // --- MessageStore ---

  private _insertMessageStmt?: ReturnType<Database.Database["prepare"]>;
  private get insertMessageStmt() {
    return (this._insertMessageStmt ??= this.db.prepare(
      `INSERT OR IGNORE INTO messages (id, chat_jid, sender_jid, from_me, timestamp, content, message_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ));
  }

  private runInsertMessage(msg: StoredMessage): void {
    this.insertMessageStmt.run(
      msg.id,
      msg.chat_jid,
      msg.sender_jid,
      msg.from_me,
      msg.timestamp,
      msg.content,
      msg.message_type,
      msg.created_at,
    );
  }

  async storeMessage(msg: StoredMessage): Promise<void> {
    this.runInsertMessage(msg);
  }

  async storeMessages(msgs: StoredMessage[]): Promise<void> {
    const batch = this.db.transaction((rows: StoredMessage[]) => {
      for (const row of rows) {
        this.runInsertMessage(row);
      }
    });
    batch(msgs);
  }

  async getMessages(
    chatJid: string,
    opts?: { limit?: number; before?: number },
  ): Promise<StoredMessage[]> {
    const limit = opts?.limit ?? 50;
    if (opts?.before) {
      return this.db
        .prepare(
          "SELECT * FROM messages WHERE chat_jid = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?",
        )
        .all(chatJid, opts.before, limit) as StoredMessage[];
    }
    return this.db
      .prepare("SELECT * FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?")
      .all(chatJid, limit) as StoredMessage[];
  }

  async getMessagesSince(chatJid: string, sinceTimestamp: number): Promise<StoredMessage[]> {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE chat_jid = ? AND timestamp >= ? ORDER BY timestamp ASC",
      )
      .all(chatJid, sinceTimestamp) as StoredMessage[];
  }
}
