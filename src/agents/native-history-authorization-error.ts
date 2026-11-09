/** A local source change must not be converted into a provider failure or cooldown. */
export class NativeHistoryAuthorizationChangedError extends Error {
  readonly code = "native_history_authorization_changed";

  constructor() {
    super(
      "The selected Claude profile changed while preparing fallback context. Retry this request.",
    );
    this.name = "NativeHistoryAuthorizationChangedError";
  }
}
