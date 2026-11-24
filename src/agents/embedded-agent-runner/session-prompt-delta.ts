/** Section-level difference between two rendered system prompts, by `## ` heading. */
function promptSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const section of text.split(/(?=^## )/m)) {
    const lineEnd = section.indexOf("\n");
    const heading = section.startsWith("## ")
      ? section.slice(0, lineEnd < 0 ? section.length : lineEnd)
      : "";
    sections.set(heading, (sections.get(heading) ?? "") + section);
  }
  return sections;
}

export function promptDelta(previous: string, current: string): string[] {
  const before = promptSections(previous);
  const sections: string[] = [];
  for (const [heading, section] of promptSections(current)) {
    if (before.get(heading) !== section) {
      sections.push(section);
    }
    before.delete(heading);
  }
  for (const heading of before.keys()) {
    sections.push(`${heading}\n(removed)`);
  }
  return sections;
}
