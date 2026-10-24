export function hasUnresolvedImageCode(
  text: string,
  start: number,
  end: number,
  regions: readonly { start: number; end: number; block: boolean }[],
  regionStart: number,
): boolean {
  let regionIndex = regionStart;
  const brackets: Array<{ image: boolean; code: boolean }> = [];
  for (let cursor = start; cursor < end; cursor += 1) {
    const region = regions[regionIndex];
    if (region?.start === cursor) {
      if (!region.block) {
        for (const bracket of brackets) {
          bracket.code ||= bracket.image;
        }
      }
      cursor = region.end - 1;
      regionIndex += 1;
    } else if (text[cursor] === "\\") {
      cursor += 1;
    } else if (text[cursor] === "!" && text[cursor + 1] === "[") {
      brackets.push({ image: true, code: false });
      cursor += 1;
    } else if (text[cursor] === "[") {
      brackets.push({ image: false, code: false });
    } else if (text[cursor] === "]" && brackets.pop()?.code) {
      return true;
    }
  }
  return brackets.some((bracket) => bracket.image && bracket.code);
}
