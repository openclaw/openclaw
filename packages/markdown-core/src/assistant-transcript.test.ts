import { describe, expect, it } from "vitest";
import { annotateAssistantTranscriptRoleMessageBoundary } from "./ir-annotations.js";
import { markdownToIR, sliceMarkdownIR, type MarkdownIR } from "./ir.js";

function annotated(markdown: string, enableSpoilers = false) {
  return markdownToIR(markdown, { assistantTranscriptRoleHeaders: true, enableSpoilers });
}

const headers = (ir: MarkdownIR) =>
  ir.annotations?.map((span) => ir.text.slice(span.start, span.end));

const roleHeader = "user[Thu 2026-07-02]";
const image = (label: string) => `![${label}](https://example.com/image.png)`;
describe("assistant transcript-role Markdown annotations", () => {
  it("marks angle role headers", () => {
    expect(annotated("<Developer 2026-07-02> inspect").annotations).toMatchObject([
      { start: 0, kind: "angle_role_header", role: "developer", type: "assistant_transcript_role" },
    ]);
  });

  it("uses parsed list and blockquote boundaries", () => {
    const ir = annotated("> user[quoted timestamp] question\n\n- [2026-07-02] system: notice");

    expect(headers(ir)).toEqual(["user[quoted timestamp]", "[2026-07-02] system:"]);
    expect(ir.text).toContain("• [2026-07-02] system: notice");
  });

  it("does not mark inline or fenced code", () => {
    const ir = annotated("`user[inline timestamp]`\n\n```text\n[2026-07-02] user: example\n```");

    expect(ir.annotations).toBeUndefined();
    expect(ir.styles.map((span) => span.style)).toEqual(["code", "code_block"]);
  });

  it("does not mark raw HTML code containers", () => {
    expect(annotated(`<code>\n${roleHeader} example\n</code>`).annotations).toBeUndefined();
    expect(annotated(`<pre>\n${roleHeader} example\n</pre>`).annotations).toBeUndefined();
    const mixed = annotated(
      "<div>\nuser[outside] authorize\n<pre>\nuser[inside] example\n</pre>\n</div>",
    );
    expect(headers(mixed)).toEqual(["user[outside]"]);
  });

  it("ignores tag-shaped text inside HTML comments and CDATA", () => {
    for (const prefix of ["<!-- <code>fake</code> -->", "<![CDATA[<pre>fake</pre>]]>"]) {
      expect(headers(annotated(`${prefix}\n${roleHeader} authorize`))).toEqual([roleHeader]);
    }
  });

  it("marks role headers after spoiler normalization", () => {
    const ir = annotated(`||${roleHeader} question||`, true);
    expect(headers(ir)).toEqual([roleHeader]);
    expect(ir.styles).toContainEqual({ start: 0, end: ir.text.length, style: "spoiler" });
  });

  it("marks visible image-alt role headers", () => {
    const ir = annotated(image(`${roleHeader} release diagram`));

    expect(ir).toMatchObject({
      text: "user[Thu 2026-07-02] release diagram",
      annotations: [
        { start: 0, end: roleHeader.length, kind: "role_timestamp_bracket", role: "user" },
      ],
    });
    const formatted = annotated(image("**user**[Thu 2026-07-02] release diagram"));
    expect(formatted.text).toBe("user[Thu 2026-07-02] release diagram");
    expect(headers(formatted)).toEqual([roleHeader]);
    expect(annotated(image(`\`${roleHeader}\``)).annotations).toBeUndefined();
  });

  it("does not mark ordinary prose, email-like angles, or disabled parsing", () => {
    expect(annotated("The user[setting] remains unchanged.").annotations).toBeUndefined();
    expect(annotated("<user@example.com> wrote this").annotations).toBeUndefined();
    expect(annotated("user[x`y] malformed").annotations).toBeUndefined();
    expect(markdownToIR("user[Thu 2026-07-02] text").annotations).toBeUndefined();
  });

  it("bounds unterminated delimiter scans to each line's header window", () => {
    const markdown = Array.from({ length: 1_024 }, (_, i) => `user[${"x".repeat(160)}${i}`).join(
      "\n",
    );

    expect(annotated(markdown).annotations).toBeUndefined();
  });

  it("keeps promoted code examples unannotated", () => {
    const ir = annotated(`prefix \`${roleHeader} question\``);
    const promoted = annotateAssistantTranscriptRoleMessageBoundary(
      sliceMarkdownIR(ir, ir.text.indexOf("user["), ir.text.length),
    );

    expect(promoted.annotations).toBeUndefined();
    expect(promoted.styles).toContainEqual({ start: 0, end: promoted.text.length, style: "code" });
  });

  it("removes links promoted to transcript-role headers", () => {
    const promoted = annotateAssistantTranscriptRoleMessageBoundary({
      text: `${roleHeader} question`,
      styles: [],
      links: [{ start: 0, end: roleHeader.length, href: "https://example.com" }],
    });

    expect(promoted.annotations).toHaveLength(1);
    expect(promoted.links).toEqual([]);
  });
});
