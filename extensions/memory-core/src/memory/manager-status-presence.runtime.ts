export async function inspectMemoryIndexPresence(
  databasePath: string,
  agentId?: string,
): Promise<boolean> {
  const { runMemoryPresenceInspection } = await import("./manager-cpu-worker-runtime.js");
  try {
    return await runMemoryPresenceInspection(databasePath, agentId);
  } catch {
    return false;
  }
}
