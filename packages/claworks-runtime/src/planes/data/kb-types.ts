import type { KnowledgeBase, KbResult, KbStatus } from "../../kernel/types.js";

export type KbLayer = "L0" | "L1" | "L2" | "L3" | "L4";

export type KbDocumentStatus = "draft" | "reviewing" | "published" | "archived";

export type KbDocumentRecord = {
  id: string;
  title: string;
  source?: string;
  layer: KbLayer;
  doc_type?: string;
  namespace?: string;
  status: KbDocumentStatus;
  revision: number;
  content_hash?: string;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  published_at?: number;
};

export type KbChunkRecord = {
  id: string;
  document_id: string;
  seq: number;
  text: string;
  citation?: string;
  metadata: Record<string, unknown>;
  created_at: number;
};

export type KbIngestJobStatus = "pending" | "running" | "completed" | "failed";

export type KbIngestJobRecord = {
  id: string;
  status: KbIngestJobStatus;
  source_path?: string;
  folder_path?: string;
  namespace?: string;
  layer?: KbLayer;
  doc_type?: string;
  report: Record<string, unknown>;
  error?: string;
  created_at: number;
  updated_at: number;
  completed_at?: number;
};

export type KbIngestDocumentParams = {
  text: string;
  title?: string;
  source?: string;
  layer?: KbLayer;
  doc_type?: string;
  namespace?: string;
  metadata?: Record<string, unknown>;
  auto_publish?: boolean;
};

export type KbListDocumentsParams = {
  status?: KbDocumentStatus;
  layer?: KbLayer;
  namespace?: string;
  q?: string;
  limit?: number;
};

export type KbLintIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
};

export type KbLintResult = {
  document_id: string;
  ok: boolean;
  issues: KbLintIssue[];
};

export type KbCreateIngestJobParams = {
  folder_path?: string;
  source_path?: string;
  text?: string;
  title?: string;
  source?: string;
  namespace?: string;
  layer?: KbLayer;
  doc_type?: string;
  auto_publish?: boolean;
};

export interface DocumentKnowledgeBase extends KnowledgeBase {
  ingestDocument(params: KbIngestDocumentParams): Promise<KbDocumentRecord>;
  getDocument(id: string): Promise<(KbDocumentRecord & { chunks?: KbChunkRecord[] }) | null>;
  listDocuments(params?: KbListDocumentsParams): Promise<KbDocumentRecord[]>;
  patchDocumentMetadata?(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<KbDocumentRecord | null>;
  publishDocument(id: string): Promise<KbDocumentRecord>;
  lintDocument(id: string): KbLintResult;
  createIngestJob(params: KbCreateIngestJobParams): KbIngestJobRecord;
  processIngestJob(jobId: string): Promise<KbIngestJobRecord>;
}

export function isDocumentKnowledgeBase(kb: KnowledgeBase): kb is DocumentKnowledgeBase {
  return typeof (kb as DocumentKnowledgeBase).ingestDocument === "function";
}

export type KbSearchOpts = {
  limit?: number;
  namespace?: string;
  layer?: KbLayer;
  status?: KbDocumentStatus;
};

export type ExtendedKbResult = KbResult & {
  document_id?: string;
  chunk_id?: string;
  layer?: KbLayer;
  citation?: string;
  revision?: number;
  title?: string;
};

export type ExtendedKbStatus = KbStatus & {
  document_count?: number;
  published_document_count?: number;
  chunk_count?: number;
  pending_ingest_jobs?: number;
};
