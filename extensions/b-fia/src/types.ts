/**
 * Shared types for B-FIA plugin.
 */

export interface BfiaAnalyzeParams {
  symbol: string;
  period?: string;
  channel?: string;
}

export interface BfiaResponse {
  [key: string]: unknown;
}
