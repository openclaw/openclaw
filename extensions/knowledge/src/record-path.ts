/** Human-readable paths; identity remains the immutable frontmatter ID. */
export function recordPath(
  directory: string,
  title: string,
  id: string,
  occupied: (path: string) => boolean,
): string {
  let slug =
    title
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 100)
      .replace(/-$/g, "") || "untitled";
  while (new TextEncoder().encode(slug).length > 180) {
    slug = Array.from(slug).slice(0, -1).join("");
  }
  const base = `${directory}${slug}`;
  if (!occupied(`${base}.md`)) {
    return `${base}.md`;
  }
  for (let length = 8; length <= id.length; length += 4) {
    const candidate = `${base}-${id.slice(0, length)}.md`;
    if (!occupied(candidate)) {
      return candidate;
    }
  }
  throw new Error("No available descriptive filename; existing files preserved.");
}
