export class BlobsterGenerationAuthorityChangedError extends Error {
  constructor() {
    super("Avatar generation access changed. Reconnect and try again.");
    this.name = "BlobsterGenerationAuthorityChangedError";
  }
}

export class BlobsterUnsupportedRuntimeError extends Error {
  constructor() {
    super("The selected runtime cannot provide tool-free avatar generation.");
    this.name = "BlobsterUnsupportedRuntimeError";
  }
}
