import path from "path";
import { getWorkspacePath, readTextFile, apiResponse } from "@/lib/workspace";

export async function GET() {
  const wsPath = getWorkspacePath();
  const content = await readTextFile(path.join(wsPath, "state", "observations.md"));
  return apiResponse({ content: content || "No observations recorded yet." });
}
