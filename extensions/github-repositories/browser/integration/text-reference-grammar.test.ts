import { describe, expect, it } from "vitest";
import type { MarkdownRenderOptions } from "../../../../ui/src/components/markdown-render-options.ts";
import {
  htmlFragment,
  toStreamingMarkdownParts,
} from "../../../../ui/src/components/markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "../../../../ui/src/components/markdown.ts";
import { githubReferenceOptions } from "./github-text-references.ts";
const render = (input: string, options: MarkdownRenderOptions = {}) =>
  htmlFragment(toSanitizedMarkdownHtml(input, githubReferenceOptions(options)));
const renderStreaming = (input: string, options: MarkdownRenderOptions = {}, id?: string) =>
  htmlFragment(toStreamingMarkdownParts(input, githubReferenceOptions(options), id).join(""));
const renderBoth = (input: string) => [render(input), renderStreaming(input)];

describe("github item references", () => {
  it.each([
    ["openclaw/clawsweeper#1576", "issues", "1576"],
    ["PR openclaw/clawsweeper#42", "pull", "42"],
    ["openclaw/clawsweeper PR #42", "pull", "42"],
    ["pull **request** *openclaw/clawsweeper#42*", "pull", "42"],
    ["issue openclaw/clawsweeper#42.", "issues", "42"],
  ])("renders an explicit repository and item kind in %s", (source, path, number) => {
    for (const fragment of renderBoth(source)) {
      const anchor = fragment.querySelector<HTMLAnchorElement>("a.markdown-github-item");
      expect(anchor?.href).toBe("https://github.com/openclaw/clawsweeper/" + path + "/" + number);
      expect(anchor?.textContent).toBe("openclaw/clawsweeper#" + number);
      expect(anchor?.dataset.githubKind).toBe(path === "pull" ? "pull" : "issue");
      expect(anchor?.classList.contains("markdown-github-link")).toBe(true);
    }
  });

  it.each([
    "PR #126",
    "#141270",
    "PR #0123",
    "issue acme/research#12345678901",
    "acme/research#126.txt",
    "word#141270",
    "../..#141270",
    "re**PR** #42",
    "PR " + String.fromCharCode(96) + "acme/research#126" + String.fromCharCode(96),
    "# PR acme/research#126",
    "[PR #126](https://example.test)",
  ])("does not invent a destination for %s", (source) => {
    for (const fragment of renderBoth(source)) {
      expect(fragment.querySelector("a.markdown-github-item")).toBeNull();
      expect(fragment.querySelector("a a")).toBeNull();
    }
  });

  it("keeps bare references plain when streamed links add another repository", () => {
    const source = "PR #126. PR acme/research#126.";
    for (const suffix of ["", " https://github.com/other/project/pull/126"]) {
      for (const fragment of [
        render(source + suffix),
        renderStreaming(source + suffix, {}, "github-explicit-stream"),
      ]) {
        const anchors = [...fragment.querySelectorAll<HTMLAnchorElement>("a.markdown-github-item")];
        expect(anchors[0]?.href).toBe("https://github.com/acme/research/pull/126");
        expect(anchors).toHaveLength(suffix ? 2 : 1);
        expect(fragment.textContent).toContain("PR #126.");
      }
    }
  });

  it("preserves explicit destinations, ordinary links, fragments, and independent repositories", () => {
    const source =
      "[PR #126](https://github.com/acme/research/pull/126#discussion_r123) and " +
      "https://github.com/other/project/issues/126, PR acme/third#126, [guide](https://example.test/guide).";
    for (const fragment of renderBoth(source)) {
      expect([...fragment.querySelectorAll<HTMLAnchorElement>("a")].map((a) => a.href)).toEqual([
        "https://github.com/acme/research/pull/126#discussion_r123",
        "https://github.com/other/project/issues/126",
        "https://github.com/acme/third/pull/126",
        "https://example.test/guide",
      ]);
      expect(fragment.querySelector("a")?.textContent).toBe("PR #126");
    }
  });
});
