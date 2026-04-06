/**
 * Ground-truth-backed scoring and token estimation.
 *
 * Scoring strategies:
 *   - text_fields:  fuzzy substring match of expected field values in extracted text
 *   - key_values:   fuzzy substring match of expected key-value pairs in extracted text
 *   - tables:       cell-level matching of expected table data in extracted text
 *   - snippets:     normalized substring containment
 *   - token estimate: character-based approximation (chars / 4)
 */

import type {
  ArmOutput,
  CorpusEntry,
  FieldScore,
  GroundTruth,
  GroundTruthTable,
  ScoreResult,
  TableScore,
} from "./types.js";

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Rough token estimate: ~4 characters per token for English text.
 * This is intentionally simple — it's for relative comparison, not billing.
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Text normalization for matching
// ---------------------------------------------------------------------------

/**
 * Normalize text for fuzzy matching: lowercase, strip markdown/formatting,
 * collapse whitespace.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`#>*_|~\-[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check if `needle` appears in `haystack` after normalization.
 */
function fuzzyContains(haystack: string, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle));
}

/**
 * Check if `needle` appears in `haystack` with a looser numeric-aware match.
 * Strips currency symbols and common separators before comparing.
 */
function numericFuzzyContains(haystack: string, needle: string): boolean {
  const strip = (s: string) => s.replace(/[$,]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  return strip(haystack).includes(strip(needle));
}

// ---------------------------------------------------------------------------
// Text fields scoring
// ---------------------------------------------------------------------------

function scoreTextFields(text: string, fields: Record<string, string>): FieldScore {
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return { found: 0, total: 0, accuracy: 1 };
  }
  const details = entries.map(([field, expected]) => ({
    field,
    expected,
    matched: fuzzyContains(text, expected),
  }));
  const found = details.filter((d) => d.matched).length;
  return {
    found,
    total: entries.length,
    accuracy: found / entries.length,
    details,
  };
}

// ---------------------------------------------------------------------------
// Key-value scoring
// ---------------------------------------------------------------------------

function scoreKeyValues(text: string, kvs: Record<string, string>): FieldScore {
  const entries = Object.entries(kvs);
  if (entries.length === 0) {
    return { found: 0, total: 0, accuracy: 1 };
  }
  const details = entries.map(([field, expected]) => ({
    field,
    expected,
    matched: numericFuzzyContains(text, expected),
  }));
  const found = details.filter((d) => d.matched).length;
  return {
    found,
    total: entries.length,
    accuracy: found / entries.length,
    details,
  };
}

// ---------------------------------------------------------------------------
// Table scoring
// ---------------------------------------------------------------------------

function scoreTable(
  text: string,
  table: GroundTruthTable,
): {
  headersMatched: number;
  headersTotal: number;
  rowsMatched: number;
  rowsTotal: number;
  cellsMatched: number;
  cellsTotal: number;
} {
  const normalizedText = normalize(text);

  // Headers
  const headersTotal = table.headers.length;
  const headersMatched = table.headers.filter((h) => normalizedText.includes(normalize(h))).length;

  // Rows: a row is "matched" if all cells appear in the text
  let rowsMatched = 0;
  let cellsMatched = 0;
  let cellsTotal = 0;
  for (const row of table.rows) {
    let rowAllFound = true;
    for (const cell of row) {
      cellsTotal++;
      if (numericFuzzyContains(text, cell)) {
        cellsMatched++;
      } else {
        rowAllFound = false;
      }
    }
    if (rowAllFound) {
      rowsMatched++;
    }
  }

  return {
    headersMatched,
    headersTotal,
    rowsMatched,
    rowsTotal: table.rows.length,
    cellsMatched,
    cellsTotal,
  };
}

function scoreTables(text: string, tables: GroundTruthTable[]): TableScore {
  if (tables.length === 0) {
    return { found: 0, total: 0, accuracy: 1 };
  }

  const details = tables.map((table) => {
    const result = scoreTable(text, table);
    return {
      label: table.label,
      headersMatched: result.headersMatched,
      headersTotal: result.headersTotal,
      rowsMatched: result.rowsMatched,
      rowsTotal: result.rowsTotal,
    };
  });

  // Aggregate cell accuracy
  let totalCells = 0;
  let matchedCells = 0;
  for (const table of tables) {
    const result = scoreTable(text, table);
    totalCells += result.cellsTotal;
    matchedCells += result.cellsMatched;
  }

  // Table-level: a table is "found" if all its headers + majority of rows matched
  const found = tables.filter((table) => {
    const result = scoreTable(text, table);
    const headersOk = result.headersMatched >= Math.ceil(result.headersTotal * 0.8);
    const rowsOk = result.rowsMatched >= Math.ceil(result.rowsTotal * 0.5);
    return headersOk && rowsOk;
  }).length;

  return {
    found,
    total: tables.length,
    accuracy: found / tables.length,
    cellAccuracy: totalCells > 0 ? matchedCells / totalCells : 1,
    details,
  };
}

// ---------------------------------------------------------------------------
// Snippet scoring
// ---------------------------------------------------------------------------

function scoreSnippets(text: string, snippets: string[]): FieldScore {
  if (snippets.length === 0) {
    return { found: 0, total: 0, accuracy: 1 };
  }
  const details = snippets.map((snippet) => ({
    field: snippet,
    expected: snippet,
    matched: fuzzyContains(text, snippet),
  }));
  const found = details.filter((d) => d.matched).length;
  return {
    found,
    total: snippets.length,
    accuracy: found / snippets.length,
    details,
  };
}

// ---------------------------------------------------------------------------
// Combined scoring
// ---------------------------------------------------------------------------

export function scoreOutput(output: ArmOutput, gt: GroundTruth): ScoreResult {
  const text = output.text;
  const result: ScoreResult = {
    tokenEstimate: output.tokenEstimate ?? estimateTokens(text),
  };

  const accuracies: number[] = [];

  if (gt.textFields && Object.keys(gt.textFields).length > 0) {
    result.textFieldsScore = scoreTextFields(text, gt.textFields);
    accuracies.push(result.textFieldsScore.accuracy);
  }

  if (gt.keyValues && Object.keys(gt.keyValues).length > 0) {
    result.keyValuesScore = scoreKeyValues(text, gt.keyValues);
    accuracies.push(result.keyValuesScore.accuracy);
  }

  if (gt.tables && gt.tables.length > 0) {
    result.tablesScore = scoreTables(text, gt.tables);
    accuracies.push(result.tablesScore.accuracy);
  }

  if (gt.expectedSnippets && gt.expectedSnippets.length > 0) {
    result.snippetScore = scoreSnippets(text, gt.expectedSnippets);
    accuracies.push(result.snippetScore.accuracy);
  }

  if (accuracies.length > 0) {
    result.overallAccuracy = accuracies.reduce((sum, a) => sum + a, 0) / accuracies.length;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Score an arm output against its corpus entry's GT
// ---------------------------------------------------------------------------

export function scoreArmOutput(output: ArmOutput, entry: CorpusEntry): ScoreResult | undefined {
  if (!entry.groundTruth) {
    return undefined;
  }
  return scoreOutput(output, entry.groundTruth);
}
