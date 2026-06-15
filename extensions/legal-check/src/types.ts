/** leading-v2.0 PHP backend the agent calls on behalf of the user. */
export interface LegalApiConfig {
  /** Base URL, e.g. https://v2.businesstimescn.com (path like /legal/save-job is appended). */
  baseUrl: string;
  /** Per-request timeout in ms. */
  timeoutMs: number;
  /**
   * Optional explicit per-user API keys: userId -> raw `sk_...`. Checked first;
   * when absent, the key is resolved (and auto-provisioned) from the api_key
   * table via `db`. The backend authenticates via `Authorization: Bearer <key>`
   * (sha256(key) -> uid in api_key), which needs no client-IP match.
   */
  apiKeys: Record<string, string>;
  /**
   * Write-capable MySQL (superworker) used to look up / auto-create a per-uid
   * api_key row when no explicit override exists. Undefined disables auto-provision.
   */
  db?: MySqlConfig;
}

/** MySQL connection config (read+write on superworker). */
export interface MySqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}
