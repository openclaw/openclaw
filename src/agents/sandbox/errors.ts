/** A local sandbox backend failed before an agent model attempt could start. */
export class SandboxProvisioningError extends Error {
  readonly backendId: string;

  constructor(backendId: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Sandbox backend "${backendId}" failed to start: ${detail}`, { cause });
    this.name = "SandboxProvisioningError";
    this.backendId = backendId;
  }
}

export function isSandboxProvisioningError(error: unknown): error is SandboxProvisioningError {
  return error instanceof SandboxProvisioningError;
}
