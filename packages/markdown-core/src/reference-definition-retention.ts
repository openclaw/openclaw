export function findUnsettledDefinitionStarts(
  text: string,
  definitions: readonly { start: number; end: number }[],
): number[] {
  if (definitions.length === 0) {
    return [];
  }
  let lastBlank = -1;
  for (const blank of text.matchAll(/(?:\r\n|\n|\r(?!\n))[ \t]*(?:\r\n|\n|\r(?!\n))/g)) {
    lastBlank = blank.index;
  }
  return definitions.filter((definition) => definition.end > lastBlank).map(({ start }) => start);
}
