/**
 * Shared types for the 3-lane PDF extraction benchmark.
 *
 * Lane A — shipped-path: measures the exact integration paths as used in OpenClaw.
 * Lane B — quality: compares parser/representation quality fairly across arms.
 * Lane C — overhead: isolates invocation/wrapper overhead from parser quality.
 */

// ---------------------------------------------------------------------------
// Arm identifiers
// ---------------------------------------------------------------------------

export type ArmId =
  | "pdfjs-text"
  | "nutrient-cli-markdown"
  | "nutrient-cli-batch-markdown"
  | "nutrient-py-text"
  | "nutrient-py-markdown"
  | "nutrient-py-vision";

export const ALL_ARM_IDS: readonly ArmId[] = [
  "pdfjs-text",
  "nutrient-cli-markdown",
  "nutrient-cli-batch-markdown",
  "nutrient-py-text",
  "nutrient-py-markdown",
  "nutrient-py-vision",
];

// ---------------------------------------------------------------------------
// Arm output (what every arm returns per document)
// ---------------------------------------------------------------------------

export type ArmOutput = {
  armId: ArmId;
  docId: string;
  text: string;
  markdown?: string;
  timing: {
    durationMs: number;
    /** True if this is a cold (first) invocation. */
    cold?: boolean;
  };
  counts: {
    chars: number;
    empty: boolean;
    imageCount: number;
    pageCountProcessed?: number;
    pageCountTotal?: number;
  };
  tokenEstimate?: number;
  error?: string;
  stderrSnippet?: string;
};

// ---------------------------------------------------------------------------
// Arm adapter interface
// ---------------------------------------------------------------------------

export type ArmAdapter = {
  id: ArmId;
  label: string;
  available: () => Promise<boolean>;
  extract: (entry: CorpusEntry, options: ArmRunOptions) => Promise<ArmOutput>;
  /** Optional batch extract for overhead comparison (Lane C). */
  extractBatch?: (entries: CorpusEntry[], options: ArmRunOptions) => Promise<ArmOutput[]>;
};

export type ArmRunOptions = {
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  nutrientCommand: string;
  nutrientTimeoutMs: number;
  warmup?: boolean;
};

// ---------------------------------------------------------------------------
// Corpus and ground truth
// ---------------------------------------------------------------------------

export type DocType =
  | "form"
  | "invoice"
  | "contract"
  | "report"
  | "tabular"
  | "ocr-scanned"
  | "mixed-layout"
  | "other";

export type CorpusEntry = {
  id: string;
  label: string;
  filePath: string;
  docType?: DocType;
  pageCount?: number;
  bytes?: number;
  groundTruth?: GroundTruth;
  /** Lazily-loaded buffer (set by corpus loader). */
  buffer?: Buffer;
};

export type GroundTruth = {
  textFields?: Record<string, string>;
  keyValues?: Record<string, string>;
  tables?: GroundTruthTable[];
  expectedSnippets?: string[];
};

export type GroundTruthTable = {
  label?: string;
  headers: string[];
  rows: string[][];
};

// ---------------------------------------------------------------------------
// Manifest format (loaded from dataset-manifest.json)
// ---------------------------------------------------------------------------

export type CorpusManifest = {
  corpus: ManifestEntry[];
};

export type ManifestEntry = {
  id: string;
  label?: string;
  file: string;
  docType?: string;
  pageCount?: number;
};

// ---------------------------------------------------------------------------
// Ground truth JSONL record
// ---------------------------------------------------------------------------

export type GroundTruthRecord = {
  doc_id: string;
  text_fields?: Record<string, string>;
  key_values?: Record<string, string>;
  tables?: Array<{ label?: string; headers: string[]; rows: string[][] }>;
  expected_snippets?: string[];
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type FieldScore = {
  found: number;
  total: number;
  accuracy: number;
  details?: Array<{ field: string; expected: string; matched: boolean }>;
};

export type TableScore = {
  found: number;
  total: number;
  accuracy: number;
  cellAccuracy?: number;
  details?: Array<{
    label?: string;
    headersMatched: number;
    headersTotal: number;
    rowsMatched: number;
    rowsTotal: number;
  }>;
};

export type ScoreResult = {
  textFieldsScore?: FieldScore;
  keyValuesScore?: FieldScore;
  tablesScore?: TableScore;
  snippetScore?: FieldScore;
  tokenEstimate: number;
  overallAccuracy?: number;
};

// ---------------------------------------------------------------------------
// Per-doc result (arm output + scoring)
// ---------------------------------------------------------------------------

export type DocResult = {
  docId: string;
  label: string;
  docType?: DocType;
  bytes: number;
  armId: ArmId;
  output: ArmOutput;
  score?: ScoreResult;
};

// ---------------------------------------------------------------------------
// Lane reports
// ---------------------------------------------------------------------------

export type LaneId = "a" | "b" | "c";

export type LaneAReport = {
  lane: "a";
  title: string;
  description: string;
  generatedAt: string;
  config: BenchConfig;
  arms: ArmId[];
  docs: DocResult[];
  aggregate: Record<ArmId, ArmAggregate>;
  comparison?: ArmComparison;
};

export type LaneBReport = {
  lane: "b";
  title: string;
  description: string;
  generatedAt: string;
  config: BenchConfig;
  arms: ArmId[];
  docs: DocResult[];
  aggregate: Record<ArmId, ArmAggregate>;
  byDocType?: Record<string, Record<ArmId, ArmAggregate>>;
  comparison?: ArmComparison;
};

export type LaneCReport = {
  lane: "c";
  title: string;
  description: string;
  generatedAt: string;
  config: BenchConfig;
  arms: ArmId[];
  overheadResults: OverheadResult[];
  aggregate: Record<ArmId, OverheadAggregate>;
};

export type OverheadResult = {
  armId: ArmId;
  docCount: number;
  totalDurationMs: number;
  perDocDurationMs: number[];
  coldDurationMs?: number;
  warmAvgDurationMs?: number;
  failureCount: number;
  throughputDocsPerSec: number;
};

export type OverheadAggregate = {
  armId: ArmId;
  docCount: number;
  avgPerDocMs: number;
  p50PerDocMs: number;
  p95PerDocMs: number;
  totalMs: number;
  throughputDocsPerSec: number;
  failureCount: number;
  coldMs?: number;
  warmAvgMs?: number;
};

export type ArmAggregate = {
  armId: ArmId;
  docCount: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  avgChars: number;
  avgTokenEstimate: number;
  emptyCount: number;
  failureCount: number;
  avgAccuracy?: number;
  avgTextFieldsAccuracy?: number;
  avgKeyValuesAccuracy?: number;
  avgTablesAccuracy?: number;
  avgSnippetAccuracy?: number;
};

export type ArmComparison = {
  baseArm: ArmId;
  arms: Array<{
    armId: ArmId;
    durationDeltaMs: number;
    durationDeltaPct: number | null;
    charsDelta: number;
    tokenDelta: number;
    accuracyDelta?: number;
  }>;
};

// ---------------------------------------------------------------------------
// Combined report
// ---------------------------------------------------------------------------

export type BenchReport = {
  node: string;
  generatedAt: string;
  config: BenchConfig;
  corpusSize: number;
  lanes: {
    a?: LaneAReport;
    b?: LaneBReport;
    c?: LaneCReport;
  };
};

export type BenchConfig = {
  runs: number;
  warmup: number;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  nutrientCommand: string;
  nutrientTimeoutMs: number;
  lanes: LaneId[];
  arms: ArmId[];
  filters: {
    docIds?: string[];
    docTypes?: string[];
    limit?: number;
  };
};
