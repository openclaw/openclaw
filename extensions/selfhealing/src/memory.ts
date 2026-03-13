import fs from "node:fs/promises";
import path from "node:path";

export type MemoryEntry = {
  timestamp: string;
  lesson: string;
  source: "session_success" | "session_failure";
};

const FILE = "selfhealing.jsonl";

export async function readMemory(workspaceDir: string): Promise<MemoryEntry[]> {
  try {
    const text = await fs.readFile(path.join(workspaceDir, FILE), "utf-8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MemoryEntry);
  } catch {
    return [];
  }
}

export async function appendMemory(workspaceDir: string, entry: MemoryEntry): Promise<void> {
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.appendFile(path.join(workspaceDir, FILE), JSON.stringify(entry) + "\n", "utf-8");
}
