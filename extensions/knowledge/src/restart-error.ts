/** Why a Knowledge call failed only because Knowledge stopped or restarted. */
export type RestartReason =
  | "service-reloaded"
  | "runtime-retired"
  | "storage-stopped"
  | "registry-stopped";

/**
 * A call that failed only because Knowledge stopped or restarted. It carries a
 * stable code like the host's own retryable unavailability: retrying the
 * original request, with the same requestId, against the current service is
 * safe. The message stays readable for agents and operators.
 */
export class KnowledgeRestartError extends Error {
  readonly code = "UNAVAILABLE";
  readonly retryable = true;
  constructor(
    readonly reason: RestartReason,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeRestartError";
  }
}
