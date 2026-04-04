/**
 * Database role interfaces - narrow contracts for each concern.
 * The composite Database interface extends all roles so SqliteDatabase
 * can implement everything in one class while consumers depend only
 * on the slice they need.
 */

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
} from "./database/schema.js";

// --- Role interfaces ---

export interface LeadRepository {
  getOrCreateLead(phoneNumber: string): Promise<Lead>;
  getLeadById(id: number): Promise<Lead | null>;
  getLeadByPhone(phoneNumber: string): Promise<Lead | null>;
  updateLeadStatus(id: number, status: LeadStatus): Promise<void>;
  updateLeadTimestamp(id: number, timestamp: number): Promise<void>;
  updateAssignedAgent(id: number, agentPhone: string | null): Promise<void>;
  updateLastBotReply(id: number, timestamp: number): Promise<void>;
  updateQualificationData(leadId: number, data: Partial<QualificationData>): Promise<void>;
  isLeadQualified(leadId: number): Promise<boolean>;
  updateQuoteData(leadId: number, data: Partial<QuoteData>): Promise<void>;
  blockLead(leadId: number, reason: string): Promise<void>;
  unblockLead(leadId: number): Promise<void>;
  resetLead(leadId: number): Promise<void>;
  getSilentLeads(thresholdHours: number, maxFollowups: number): Promise<Lead[]>;
  updateFollowUpSentAt(id: number, timestamp: number): Promise<void>;
  getStats(): Promise<LeadStats>;
  getRecentLeads(limit: number): Promise<Lead[]>;
  updateCustomFields(leadId: number, fields: Record<string, unknown>): Promise<void>;
  upsertLead(
    phone: string,
    data: Partial<QualificationData & QuoteData & { notes: string }>,
  ): Promise<Lead>;
  listLeads(filters?: { status?: string; score?: string }): Promise<Lead[]>;
  updateReceiptData(
    leadId: number,
    data: { receipt_data: string; tariff?: string; annual_kwh?: number },
  ): Promise<void>;
}

export interface RateLimitStore {
  getLeadById(id: number): Promise<Lead | null>;
  updateRateLimitCount(leadId: number, count: number): Promise<void>;
  updateRateLimitWindow(leadId: number, windowStart: number): Promise<void>;
  resetRateLimit(leadId: number): Promise<void>;
  checkAndRecordMessage(
    leadId: number,
    maxMessages: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; count: number; reason?: string }>;
}

export interface GlobalRateLimitStore {
  getGlobalRateLimit(): Promise<GlobalRateLimitRow>;
  incrementGlobalCount(): Promise<GlobalRateLimitRow>;
  resetGlobalWindow(now: number): Promise<void>;
}

export interface CircuitBreakerStore {
  getCircuitBreaker(): Promise<CircuitBreakerRow>;
  recordCircuitCheck(wasHit: boolean): Promise<CircuitBreakerRow>;
  tripCircuitBreaker(reason: string): Promise<void>;
  resetCircuitBreaker(): Promise<void>;
  resetCircuitWindow(now: number): Promise<void>;
}

export interface ExtractionStore {
  createExtractionRecord(
    leadId: number,
    fileSize: number | null,
    filePath: string | null,
  ): Promise<number>;
  updateExtractionStatus(
    extractionId: number,
    status: ExtractionStatus,
    error?: string | null,
  ): Promise<void>;
  getExtractionAttempts(leadId: number): Promise<ReceiptExtraction[]>;
  getPendingExtraction(leadId: number): Promise<ReceiptExtraction | null>;
  getRecentExtractionFailures(windowMs: number): Promise<number>;
}

export interface LabelStore {
  getLabelId(name: string): Promise<string | null>;
  upsertLabel(name: string, waLabelId: string, color: number): Promise<void>;
  getAllLabels(): Promise<WhatsAppLabel[]>;
}

export interface MessageStore {
  storeMessage(msg: StoredMessage): Promise<void>;
  storeMessages(msgs: StoredMessage[]): Promise<void>;
  getMessages(
    chatJid: string,
    opts?: { limit?: number; before?: number },
  ): Promise<StoredMessage[]>;
  getMessagesSince(chatJid: string, sinceTimestamp: number): Promise<StoredMessage[]>;
}

export interface HandoffLog {
  logHandoffEvent(
    leadId: number,
    event: string,
    triggeredBy: string,
    metadata?: unknown,
  ): Promise<void>;
}

// --- Lifecycle ---

export interface DatabaseLifecycle {
  migrate(): void | Promise<void>;
  close(): void | Promise<void>;
}

// --- Composite interface (backward-compatible) ---

export interface Database
  extends
    DatabaseLifecycle,
    LeadRepository,
    RateLimitStore,
    GlobalRateLimitStore,
    CircuitBreakerStore,
    ExtractionStore,
    HandoffLog,
    LabelStore,
    MessageStore {}
