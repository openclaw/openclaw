/** Preserve mutation uncertainty when a caller loses the execution response. */
export async function withWebMcpOutcome<T>(
  action: "list" | "execute",
  send: () => Promise<T>,
): Promise<T> {
  try {
    return await send();
  } catch (cause) {
    if (action === "list") {
      throw cause;
    }
    // Transport cancellation cannot undo page mutations. Never forward generic retry advice.
    throw new Error("WebMCP execution outcome unknown. Inspect the page before retrying.", {
      cause,
    });
  }
}
