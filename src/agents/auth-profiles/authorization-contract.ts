/** One credential owner’s live authorization lifetime, separate from bearer material. */
export type AuthProfileAuthorization = {
  /** Opaque, non-secret, stable across token refresh; changes after disconnect/replacement. */
  readonly authorizationId: string;
  /** Cheap current-owner assertion for the final admission/commit boundary. */
  assertCurrent: () => void;
  /** Observe canonical owner state before intake/admission, including other-process changes. */
  revalidate: () => Promise<void>;
  dispose: () => void;
};

/** Known lifetime loss differs from a temporarily unavailable authority observation.
 * Keep the original MCP error name/codes for callers of the existing authority contract.
 */
export class AuthProfileAuthorizationError extends Error {
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
