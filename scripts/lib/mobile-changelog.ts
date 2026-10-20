function matchChangelogHeading(line: string, heading: string): boolean {
  const normalized = line.trim();
  return normalized === `## ${heading}` || normalized.startsWith(`## ${heading} - `);
}

export function extractChangelogSection(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/u);
  const startIndex = lines.findIndex((line) => matchChangelogHeading(line, heading));
  if (startIndex === -1) {
    return null;
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("## ")) {
      endIndex = index;
      break;
    }
  }

  const body = lines
    .slice(startIndex + 1, endIndex)
    .join("\n")
    .trim();
  return body || null;
}
