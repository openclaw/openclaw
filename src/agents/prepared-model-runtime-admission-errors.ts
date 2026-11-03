export class PreparedModelRuntimeOwnerNotPublishedError extends Error {
  readonly admissionBlocked: boolean;

  constructor(message?: string, options?: ErrorOptions & { admissionBlocked?: boolean }) {
    super(message, options);
    this.admissionBlocked = options?.admissionBlocked === true;
  }
}

/** Facts recorded by the recovery owner, including when another attempt is eligible. */
export class PreparedModelRuntimeRecoveryError extends PreparedModelRuntimeOwnerNotPublishedError {
  constructor(
    agentId: string,
    readonly reason: "attempt-failed" | "backoff",
    readonly nextEligibleAt: number,
    options?: ErrorOptions,
  ) {
    super(
      `prepared reply dispatch runtime owner was not published for ${agentId}; ${reason === "backoff" ? "recovery is waiting for retry" : "recovery failed"}. Check Gateway logs for the underlying publication error.`,
      options,
    );
  }
}
