/**
 * First user turn for a native `sessions_spawn` / subagent run. The full task
 * string must not be repeated here: it already appears under **Your Role** in
 * the subagent system prompt. Duplicating it doubled input tokens (#72019).
 */
export function buildSubagentInitialUserMessage(params: {
  childDepth: number;
  maxSpawnDepth: number;
  /** When true, this subagent uses a persistent session for follow-up messages. */
  persistentSession: boolean;
}): string {
  const lines: string[] = [
    `[Subagent Context] You are running as a subagent (depth ${params.childDepth}/${params.maxSpawnDepth}). Results auto-announce to your requester; do not busy-poll for status.`,
  ];
  if (params.persistentSession) {
    lines.push(
      "[Subagent Context] This subagent session is persistent and remains available for thread follow-up messages.",
    );
  }
  lines.push(
    "Begin. Your assigned task is in the system prompt under **Your Role**; execute it to completion.",
  );
  return lines.join("\n\n");
}
