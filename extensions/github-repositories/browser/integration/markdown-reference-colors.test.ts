import { expect, it } from "vitest";
import { htmlFragment } from "../../../../ui/src/components/markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "../../../../ui/src/components/markdown.ts";
import { githubReferenceOptions } from "./github-text-references.ts";
function swatches(fragment: HTMLElement) {
  return [...fragment.querySelectorAll<HTMLImageElement>(".markdown-hex-color__swatch")];
}
it("keeps repository references as links and reader documents literal", () => {
  const fragment = htmlFragment(
    toSanitizedMarkdownHtml(
      "PR openclaw/openclaw#178969, color #aabbcc.",
      githubReferenceOptions(),
    ),
  );
  expect(fragment.querySelector("a")?.getAttribute("href")).toBe(
    "https://github.com/openclaw/openclaw/pull/178969",
  );
  expect(swatches(fragment).map((image) => image.parentElement?.textContent)).toEqual(["#aabbcc"]);
  expect(
    swatches(htmlFragment(toSanitizedMarkdownHtml("#abc", { mode: "document" }))),
  ).toHaveLength(0);
});
