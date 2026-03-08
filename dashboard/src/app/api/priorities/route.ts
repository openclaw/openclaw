import path from "path";
import { getWorkspacePath, readTextFile, apiResponse } from "@/lib/workspace";

export async function GET() {
  const wsPath = getWorkspacePath();
  const content = await readTextFile(path.join(wsPath, "shared-context", "priorities.md"));
  return apiResponse({ content: content || "No priorities set." });
}
