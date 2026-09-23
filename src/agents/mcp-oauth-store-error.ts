export class McpOAuthStoreCorruptionError extends Error {
  constructor(storeKey: string, detail: string, options?: { cause?: unknown }) {
    super(`MCP OAuth store ${storeKey} is invalid: ${detail}`, options);
    this.name = "McpOAuthStoreCorruptionError";
  }
}
