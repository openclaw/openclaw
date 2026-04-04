export function buildNoResponseTimeoutMessage(): string {
  return (
    "Request timed out before a response was generated. " +
    "Please try again, or increase `agents.defaults.timeoutSeconds` in your config. " +
    "If the model produced no tokens before timing out, also consider increasing " +
    "`agents.defaults.llm.idleTimeoutSeconds`."
  );
}
