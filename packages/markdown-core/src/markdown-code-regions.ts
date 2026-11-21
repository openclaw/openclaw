import { parse, postprocess, preprocess } from "micromark";
import { gfmTable } from "micromark-extension-gfm-table";

type MarkdownCodeRegion = { start: number; end: number; block: boolean };

/** Read exact original UTF-16 code ranges without building a Markdown tree. */
export function findMarkdownCodeRegions(text: string): MarkdownCodeRegion[] {
  if (!/[`~\t]| {4}/u.test(text)) {
    return [];
  }
  const events = postprocess(
    parse({ extensions: [{ disable: { null: ["htmlFlow", "htmlText"] } }, gfmTable()] })
      .document()
      .write(preprocess()(text, undefined, true)),
  );
  const regions: MarkdownCodeRegion[] = [];
  let imageDepth = 0;
  for (const [phase, token] of events) {
    if (token.type === "image") {
      imageDepth += phase === "enter" ? 1 : -1;
    }
    // Resolved image labels become alt text, so their inline code is not protected.
    if (
      phase === "enter" &&
      imageDepth === 0 &&
      (token.type === "codeText" || token.type === "codeFenced" || token.type === "codeIndented")
    ) {
      regions.push({
        start: token.start.offset,
        end: token.end.offset,
        block: token.type !== "codeText",
      });
    }
  }
  return regions;
}

export function findMarkdownCodeSpans(text: string): Array<[number, number]> {
  return findMarkdownCodeRegions(text).map(({ start, end }) => [start, end]);
}
