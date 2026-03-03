/** Standard tool response helper — returns content + details for OpenClaw tool protocol. */
export const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});
