export const delegation = (id: string, text = "Run the same action.") => ({
  type: "delegation.created",
  item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text }] },
});
export const publicDelegation = (id = "pending", offset_ms = 0) => ({
  type: "session.delegation.created",
  offset_ms,
  delegation: { type: "delegation", target: "client", id },
});
export const transcript = (delta: string, start_ms = 0, side: "input" | "output" = "input") => ({
  type: `session.${side}_transcript.delta`,
  delta,
  start_ms,
  end_ms: start_ms + 100,
});
export const turn = (role: "user" | "assistant", text: string) => ({
  type: "turn.done",
  turn: { role, transcript: text },
});
