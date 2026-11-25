export class OcPathEditError extends Error {
  constructor(
    readonly reason:
      | "unresolved"
      | "no-root"
      | "not-writable"
      | "no-item-kv"
      | "not-a-value-line"
      | "parse-error"
      | "type-mismatch"
      | "wildcard-not-allowed",
    readonly detail?: string,
  ) {
    super(detail ?? reason);
    this.name = "OcPathEditError";
  }
}
