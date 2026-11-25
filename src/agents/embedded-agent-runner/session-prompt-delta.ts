/** Section text grouped by heading, with each heading occurrence kept in source order. */
function promptSections(text: string) {
  const sections = new Map<string, string[]>();
  const order = new Set<string>();
  for (const section of text.split(/(?=^## )/m)) {
    const lineEnd = section.indexOf("\n");
    const heading = section.startsWith("## ")
      ? section.slice(0, lineEnd < 0 ? section.length : lineEnd)
      : "";
    const group = sections.get(heading) ?? [];
    order.add(JSON.stringify([heading, group.length]));
    group.push(section);
    sections.set(heading, group);
  }
  return { sections, order };
}

export function promptDelta(previous: string, current: string): string[] {
  const before = promptSections(previous);
  const after = promptSections(current);
  const beforeOrder = [...before.order].filter((heading) => after.order.has(heading));
  const afterOrder = [...after.order].filter((heading) => before.order.has(heading));
  if (beforeOrder.some((heading, index) => heading !== afterOrder[index])) {
    return [
      "Section order changed. The complete current system prompt below replaces all earlier sections and their order.\n\n" +
        current,
    ];
  }
  const sections: string[] = [];
  for (const [heading, group] of after.sections) {
    const section = group.join("");
    if (before.sections.get(heading)?.join("") !== section) {
      sections.push(section);
    }
    before.sections.delete(heading);
  }
  for (const heading of before.sections.keys()) {
    sections.push(`${heading}\n(removed)`);
  }
  return sections;
}
