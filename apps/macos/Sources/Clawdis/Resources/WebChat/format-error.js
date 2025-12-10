// Shared formatter for WebChat bootstrap errors so UI shows actionable messages.
export const formatError = (err) => {
  if (!err) return "Unknown error";
  if (err instanceof Error) return err.stack || err.message || String(err);

  const isCloseEvent =
    (typeof CloseEvent !== "undefined" && err instanceof CloseEvent) ||
    (typeof err?.code === "number" &&
      (err?.reason !== undefined || err?.wasClean !== undefined));
  if (isCloseEvent) {
    const reason = err.reason?.trim();
    const parts = [`WebSocket closed (${err.code})`];
    if (reason) parts.push(`reason: ${reason}`);
    if (err.wasClean) parts.push("clean close");
    return parts.join("; ");
  }

  const isWsErrorEvent =
    err?.type === "error" && typeof err?.target?.readyState === "number";
  if (isWsErrorEvent) {
    const states = ["connecting", "open", "closing", "closed"];
    const stateLabel = states[err.target.readyState] ?? err.target.readyState;
    return `WebSocket error (state: ${stateLabel})`;
  }

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};
