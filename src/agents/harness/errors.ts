export class AgentHarnessNotRegisteredError extends Error {
  readonly code = "agent_harness_not_registered";
  readonly runtime: string;

  constructor(runtime: string) {
    super(`Requested agent harness "${runtime}" is not registered.`);
    this.name = "AgentHarnessNotRegisteredError";
    this.runtime = runtime;
  }
}

export function isAgentHarnessNotRegisteredError(
  error: unknown,
): error is AgentHarnessNotRegisteredError {
  return (
    error instanceof AgentHarnessNotRegisteredError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "agent_harness_not_registered")
  );
}
