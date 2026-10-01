/** Terminal loss of original requester custody, not an ambiguous transport failure. */
export class RequesterAuthorityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RequesterAuthorityError";
  }
}
