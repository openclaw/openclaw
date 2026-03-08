import path from "path";
import { getWorkspacePath, readTextFile, apiResponse } from "@/lib/workspace";
import type { ContentItem } from "@/lib/types";

function parseContentQueue(markdown: string): ContentItem[] {
  const items: ContentItem[] = [];
  const lines = markdown.split("\n");
  let currentItem: Partial<ContentItem> | null = null;

  for (const line of lines) {
    const titleMatch = line.match(/^[-*]\s+\*\*(.+?)\*\*/);
    if (titleMatch) {
      if (currentItem?.title) {
        items.push(currentItem as ContentItem);
      }
      currentItem = {
        id: `content-${items.length + 1}`,
        title: titleMatch[1],
        status: "draft",
      };

      // Check for status markers
      const lower = line.toLowerCase();
      if (lower.includes("[published]") || lower.includes("✅")) currentItem.status = "published";
      else if (lower.includes("[approved]") || lower.includes("[ready]")) currentItem.status = "approved";
      else if (lower.includes("[review]") || lower.includes("[pending]")) currentItem.status = "review";
      else currentItem.status = "draft";

      // Check for platform
      if (lower.includes("twitter") || lower.includes("x.com")) currentItem.platform = "Twitter";
      else if (lower.includes("linkedin")) currentItem.platform = "LinkedIn";
      else if (lower.includes("blog")) currentItem.platform = "Blog";
      else if (lower.includes("discord")) currentItem.platform = "Discord";

      continue;
    }

    if (currentItem && line.trim() && !line.startsWith("#")) {
      currentItem.preview = (currentItem.preview || "") + line.trim() + " ";
    }
  }

  if (currentItem?.title) items.push(currentItem as ContentItem);
  return items;
}

export async function GET() {
  const wsPath = getWorkspacePath();
  const queueMd = await readTextFile(path.join(wsPath, "content", "queue.md"));

  const items = queueMd ? parseContentQueue(queueMd) : [];

  const counts = {
    draft: items.filter((i) => i.status === "draft").length,
    review: items.filter((i) => i.status === "review").length,
    approved: items.filter((i) => i.status === "approved").length,
    published: items.filter((i) => i.status === "published").length,
  };

  return apiResponse({ items, counts });
}
