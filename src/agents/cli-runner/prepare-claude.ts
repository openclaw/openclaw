export function detectNodeClaudePlacement(params: {
  backendId: string;
  execHost?: string;
  execNode?: string;
}): boolean {
  if (params.backendId === "claude-cli" && params.execHost === "node" && !params.execNode?.trim()) {
    throw new Error("node-placed Claude CLI session is missing execNode");
  }
  return (
    params.backendId === "claude-cli" &&
    params.execHost === "node" &&
    Boolean(params.execNode?.trim())
  );
}
