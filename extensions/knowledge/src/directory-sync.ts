import { syncDirectorySync } from "@openclaw/fs-safe/durability";

/** Keep SQLite publication fences synchronous. Windows may lack directory
 * flushing, but fs-safe still verifies the directory and propagates real I/O errors. */
export function syncKnowledgeDirectory(directory: string): void {
  const outcome = syncDirectorySync(directory, { label: "Knowledge directory" });
  if (outcome.status !== "synced" && process.platform !== "win32") {
    throw new Error(
      `Knowledge directory synchronization unsupported: ${outcome.code ?? "unknown"}`,
    );
  }
}
