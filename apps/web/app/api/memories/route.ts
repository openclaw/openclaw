import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const dynamic = "force-dynamic";

type MemoryFile = {
  name: string;
  path: string;
  sizeBytes: number;
};

export async function GET() {
  const workspaceDir = join(homedir(), ".openclaw", "workspace");
  let mainMemory: string | null = null;
  const dailyLogs: MemoryFile[] = [];

  // Read main MEMORY.md
  for (const filename of ["MEMORY.md", "memory.md"]) {
    const memPath = join(workspaceDir, filename);
    if (existsSync(memPath)) {
      try {
        mainMemory = readFileSync(memPath, "utf-8");
      } catch {
        // skip unreadable
      }
      break;
    }
  }

  // Scan daily log files
  const memoryDir = join(workspaceDir, "memory");
  if (existsSync(memoryDir)) {
    try {
      const entries = readdirSync(memoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const filePath = join(memoryDir, entry.name);
        try {
          const content = readFileSync(filePath, "utf-8");
          dailyLogs.push({
            name: entry.name,
            path: filePath,
            sizeBytes: Buffer.byteLength(content, "utf-8"),
          });
        } catch {
          // skip
        }
      }
    } catch {
      // dir unreadable
    }
  }

  // Sort daily logs by name (date-based filenames sort chronologically)
  dailyLogs.sort((a, b) => b.name.localeCompare(a.name));

  return Response.json({
    mainMemory,
    dailyLogs,
    workspaceDir,
  });
}
