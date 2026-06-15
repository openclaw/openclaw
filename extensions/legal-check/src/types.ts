/** leading-v2.0 PHP backend the agent calls on behalf of the user. */
export interface LegalApiConfig {
  /** Base URL, e.g. https://v2.businesstimescn.com (path like /legal/save-job is appended). */
  baseUrl: string;
  /** Per-request timeout in ms. */
  timeoutMs: number;
}
