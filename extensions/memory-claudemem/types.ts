/** Search result from claude-mem worker (index format) */
export type SearchResult = {
  id: number;
  title: string;
  snippet?: string;
  score?: number;
};

/** Full observation from claude-mem worker */
export type Observation = {
  id: number;
  narrative: string;
  files_modified?: string[];
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  created_at_epoch?: number;
};

/** Plugin configuration */
export type ClaudeMemConfig = {
  workerUrl: string;
  workerTimeout: number;
};
