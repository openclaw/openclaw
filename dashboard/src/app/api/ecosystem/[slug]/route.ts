import path from "path";
import { getWorkspacePath, readTextFile, readJsonFile, listFiles, apiResponse, apiError } from "@/lib/workspace";
import { type NextRequest } from "next/server";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const wsPath = getWorkspacePath();
  const ecoDir = path.join(wsPath, "ecosystem", slug);

  // Try reading overview and metrics
  const overview = await readTextFile(path.join(ecoDir, "overview.md"));
  const metrics = await readJsonFile(path.join(ecoDir, "metrics.json"));
  const files = await listFiles(ecoDir);

  if (!overview && !metrics && files.length === 0) {
    return apiError(`Ecosystem product '${slug}' not found`, 404);
  }

  // Read all markdown files in the product directory
  const sections: Record<string, string> = {};
  for (const file of files) {
    if (file.endsWith(".md")) {
      const content = await readTextFile(path.join(ecoDir, file));
      if (content) {
        sections[file.replace(".md", "")] = content;
      }
    }
  }

  return apiResponse({
    slug,
    overview: overview || "",
    metrics: metrics || {},
    sections,
    files,
  });
}
