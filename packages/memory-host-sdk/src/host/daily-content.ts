import fs from "node:fs/promises";

export function isSessionSummaryDailyMemory(raw: string): boolean {
  return (
    /^# Session:\s+/m.test(raw) &&
    /^-\s+\*\*Session Key\*\*:/m.test(raw) &&
    /^-\s+\*\*Session ID\*\*:/m.test(raw) &&
    /^-\s+\*\*Source\*\*:/m.test(raw)
  );
}

export async function filterSessionSummaryDailyMemoryFiles(filePaths: string[]): Promise<string[]> {
  const keptPaths: string[] = [];
  for (const filePath of filePaths) {
    const raw = await fs.readFile(filePath, "utf-8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (raw === null || isSessionSummaryDailyMemory(raw)) {
      continue;
    }
    keptPaths.push(filePath);
  }
  return keptPaths;
}
