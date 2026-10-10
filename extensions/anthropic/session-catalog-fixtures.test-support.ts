import fs from "node:fs/promises";
import path from "node:path";

export function projectFile(home: string, ...parts: string[]): string {
  return path.join(home, ".claude", "projects", "-workspace", ...parts);
}

export async function writeProject(params: {
  home: string;
  project?: string;
  entries: Array<Record<string, unknown>>;
  transcripts: Record<string, Array<Record<string, unknown>>>;
}): Promise<void> {
  const projectDir = path.join(params.home, ".claude", "projects", params.project ?? "-workspace");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({ version: 1, entries: params.entries }),
  );
  await Promise.all(
    Object.entries(params.transcripts).map(([sessionId, rows]) =>
      fs.writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      ),
    ),
  );
}

export function message(
  sessionId: string,
  type: "user" | "assistant",
  text: string | Record<string, unknown>[],
  index: number,
): Record<string, unknown> {
  return {
    type,
    sessionId,
    uuid: `${sessionId}-${index}`,
    timestamp: `2026-07-0${index}T00:00:00.000Z`,
    isSidechain: false,
    message: {
      role: type,
      content: typeof text === "string" ? [{ type: "text", text }] : text,
      ...(type === "assistant" ? { model: "claude-opus-4-8" } : {}),
    },
  };
}
