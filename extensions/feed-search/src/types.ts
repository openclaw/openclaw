/** Feed data search request */
export interface FeedDataSearchRequest {
  userId: string;
  itemId?: number | null;
  q?: string | null;
  limit: number;
  offset: number;
}

/** Feed data search response */
export interface FeedDataSearchResponse {
  success: boolean;
  data?: FeedRecord[];
  total?: number;
  visibleFields?: string[];
  error?: string;
}

/** A single feed record returned to the client */
export interface FeedRecord {
  id: number;
  author: string | null;
  reporter: string | null;
  title: string | null;
  titleClean: string | null;
  content: string | null;
  label: string | null;
  keywords: string | null;
  keySentences: string | null;
  summary: string | null;
  result: Record<string, unknown>;
  eventDate: string | null;
}

/** MySQL row tuple from feed query (positional columns) */
export type FeedRow = [
  number, // id
  string | null, // author
  string | null, // reporter
  string | null, // title
  string | null, // titleClean
  string | null, // content
  string | null, // label
  string | null, // keywords
  string | null, // keySentences
  string | null, // summary
  string | null, // result (JSON string)
  Date | null, // eventDate
];

/** MySQL connection config */
export interface MySqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}
