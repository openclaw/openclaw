/** Model-facing retry guidance appended to Browser control transport failures. */
export const BROWSER_TOOL_PERSISTENT_MODEL_HINT =
  "Do NOT retry the browser tool — it will keep failing. " +
  "Use an alternative approach or inform the user that the browser is currently unavailable.";
export const BROWSER_TOOL_TRANSIENT_MODEL_HINT =
  "This may be a transient browser error. Retry the browser tool once. " +
  "If the same error persists, use an alternative approach or inform the user that the browser is currently unavailable.";

/** Remove generic retry guidance from a message whose action may already have taken effect. */
export function stripBrowserToolModelHints(message: string): string {
  return message
    .replaceAll(BROWSER_TOOL_PERSISTENT_MODEL_HINT, "")
    .replaceAll(BROWSER_TOOL_TRANSIENT_MODEL_HINT, "")
    .trim();
}
