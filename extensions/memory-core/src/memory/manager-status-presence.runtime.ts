export async function inspectMemoryIndexPresence(databasePath: string): Promise<boolean> {
  const { runMemoryPresenceInspection } = await import("./manager-cpu-worker-runtime.js");
  try {
    return await runMemoryPresenceInspection(databasePath);
  } catch {
    return false;
  }
}
