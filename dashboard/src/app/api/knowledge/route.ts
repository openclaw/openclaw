import path from "path";
import fs from "fs/promises";
import { getWorkspacePath, apiResponse } from "@/lib/workspace";
import { type NextRequest } from "next/server";

async function searchFiles(
  dir: string,
  query: string,
  results: Array<{ file: string; line: number; context: string }>,
  maxResults = 50
): Promise<void> {
  if (results.length >= maxResults) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxResults) break;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      await searchFiles(fullPath, query, results, maxResults);
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".json") || entry.name.endsWith(".txt")) {
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        const lines = content.split("\n");
        const lowerQuery = query.toLowerCase();

        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break;
          if (lines[i].toLowerCase().includes(lowerQuery)) {
            const wsPath = getWorkspacePath();
            results.push({
              file: path.relative(wsPath, fullPath).replace(/\\/g, "/"),
              line: i + 1,
              context: lines.slice(Math.max(0, i - 1), i + 2).join("\n").slice(0, 300),
            });
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }
}

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q");
  if (!query?.trim()) {
    return apiResponse([]);
  }

  const wsPath = getWorkspacePath();
  const results: Array<{ file: string; line: number; context: string }> = [];
  await searchFiles(wsPath, query.trim(), results);

  return apiResponse(results);
}
