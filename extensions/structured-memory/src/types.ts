import type {
  MemoryCorpusSearchResult,
  MemoryCorpusGetResult,
} from "openclaw/plugin-sdk/memory-state";

const RECORD_TYPES = [
  "entity",
  "event",
  "fact",
  "rule",
  "impression",
  "plan",
  "reflex",
  "preference",
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

const RECORD_STATUSES = ["active", "archived"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export interface MemoryRecord {
  id: string;
  type: RecordType;
  summary: string;
  confidence: number;
  importance: number;
  salience: number;
  status: RecordStatus;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  expire_at: string | null;
  activate_at: string | null;
  contradiction_flag: 0 | 1;
  allow_coexistence: 0 | 1;
  critical: 0 | 1;
  consolidation_count: number;
  content: string | null;
  keywords: string;
  agent_id: string;
  source_session_id: string | null;
  attributes: string;
}

export interface RecordAttributes {
  people?: string[];
  topics?: string[];
  emotions?: string[];
  links?: string[];
  source?: string;
  [key: string]: unknown;
}

export interface RecordFindFilters {
  type?: RecordType[];
  status?: RecordStatus;
  importance_min?: number;
  importance_max?: number;
  confidence_min?: number;
  confidence_max?: number;
  keywords_contains?: string;
  text_contains?: string;
  max_results?: number;
}

export interface ClassificationResult {
  type: RecordType;
  importance: number;
  confidence: number;
  summary_refined: string;
  keywords: string;
}

export interface ClassificationError {
  code: "MODEL_UNAVAILABLE" | "PARSE_FAILURE" | "TIMEOUT" | "RATE_LIMITED";
  message: string;
}

export interface RelevanceResult {
  relevance: number;
  decay_factor: number;
  access_boost: number;
  maintenance_score: number;
  should_archive: boolean;
  archive_reason?: string;
}

export interface RecordFindResult {
  record: MemoryRecord;
  relevance: RelevanceResult;
}

export interface MaintenanceResult {
  archived_expired: number;
  archived_decayed: number;
  total_scanned: number;
}
