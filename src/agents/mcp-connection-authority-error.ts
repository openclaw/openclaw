/** Known lifetime loss differs from a temporarily unavailable authority observation. */
export class McpConnectionAuthorityError extends Error {
  readonly code: "MCP_AUTHORIZATION_RETIRED" | "MCP_AUTHORIZATION_UNAVAILABLE";
  constructor(disposition: "retired" | "unavailable") {
    super(
      disposition === "retired"
        ? "MCP authorization was disconnected or replaced"
        : "MCP authorization state is temporarily unavailable",
    );
    this.name = "McpConnectionAuthorityError";
    this.code =
      disposition === "retired" ? "MCP_AUTHORIZATION_RETIRED" : "MCP_AUTHORIZATION_UNAVAILABLE";
  }
}
