function jsonToolResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: data
  };
}
function unknownToolActionResult(action) {
  return jsonToolResult({ error: `Unknown action: ${String(action)}` });
}
function toolExecutionErrorResult(error) {
  return jsonToolResult({ error: error instanceof Error ? error.message : String(error) });
}
export {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult
};
