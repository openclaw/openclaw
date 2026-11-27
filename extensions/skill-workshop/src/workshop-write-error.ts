/** Refusal the model (or operator) can act on; the message says what to change. */
export class WorkshopWriteError extends Error {
  override name = "WorkshopWriteError";
}
