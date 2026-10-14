/** One credential owner’s live authorization lifetime, separate from bearer material. */
export type McpConnectionAuthority = {
  /** Opaque, non-secret, stable across token refresh; changes after disconnect/replacement. */
  readonly authorizationId: string;
  /** Cheap current-owner assertion for the final admission/commit boundary. */
  assertCurrent: () => void;
  /** Observe canonical owner state before intake/admission, including other-process changes. */
  revalidate: () => Promise<void>;
  dispose: () => void;
};
