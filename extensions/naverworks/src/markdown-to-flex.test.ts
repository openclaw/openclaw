import { describe, expect, it } from "vitest";
import { hasMarkdownFeatures, markdownToNaverWorksFlexTemplate } from "./markdown-to-flex.js";

describe("markdownToNaverWorksFlexTemplate", () => {
  it("returns null when text is plain", () => {
    expect(markdownToNaverWorksFlexTemplate("hello world")).toBeNull();
    expect(hasMarkdownFeatures("hello world")).toBe(false);
  });

  it("converts markdown heading/list/link into flex bubble", () => {
    const payload = markdownToNaverWorksFlexTemplate(
      "# Status\n- item one\n- item two\nSee [OpenClaw](https://openclaw.ai)",
    );

    expect(payload).toBeTruthy();
    expect(payload?.contents.type).toBe("bubble");
    expect(JSON.stringify(payload)).toContain("Status");
    expect(JSON.stringify(payload)).toContain("• item one");
    expect(JSON.stringify(payload)).toContain("OpenClaw (https://openclaw.ai)");
  });

  it("adds uri actions to text nodes that contain URLs", () => {
    const payload = markdownToNaverWorksFlexTemplate(
      "# Links\nRead https://docs.openclaw.ai/configuration",
    );

    expect(payload).toBeTruthy();
    expect(JSON.stringify(payload)).toContain('"type":"uri"');
    expect(JSON.stringify(payload)).toContain('"uri":"https://docs.openclaw.ai/configuration"');
  });

  it("normalizes domain-only URLs and strips trailing punctuation", () => {
    const payload = markdownToNaverWorksFlexTemplate(
      "# Links\nRead docs.openclaw.ai/configuration, then www.openclaw.ai/support.",
    );

    expect(payload).toBeTruthy();
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('"uri":"https://docs.openclaw.ai/configuration"');
    expect(serialized).toContain('"text":"Read "');
    expect(serialized).toContain('"text":"docs.openclaw.ai/configuration"');
    expect(serialized).toContain('"text":" then "');
    expect(serialized).toContain('"text":"www.openclaw.ai/support"');
  });

  it("creates separate clickable actions for multiple URLs in one line", () => {
    const payload = markdownToNaverWorksFlexTemplate(
      "# Links\nRead docs.openclaw.ai/configuration and https://openclaw.ai/support",
    );

    expect(payload).toBeTruthy();
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('"layout":"baseline"');
    expect(serialized).toContain('"uri":"https://docs.openclaw.ai/configuration"');
    expect(serialized).toContain('"uri":"https://openclaw.ai/support"');
  });

  it("uses higher-contrast text colors and md size for light theme", () => {
    const payload = markdownToNaverWorksFlexTemplate("# Title\n- hello", { theme: "light" });

    expect(payload).toBeTruthy();
    const textNodes = (payload?.contents.body.contents ?? []).filter(
      (entry) => entry.type === "text",
    );
    expect(textNodes.length).toBeGreaterThan(0);
    expect(textNodes.every((entry) => entry.type === "text" && entry.size === "md")).toBe(true);
    expect(JSON.stringify(payload)).toContain('"color":"#000000"');
    expect(JSON.stringify(payload)).toContain('"color":"#111111"');
  });

  it("uses light text in dark theme", () => {
    const payload = markdownToNaverWorksFlexTemplate("# Title\n- hello", { theme: "dark" });

    expect(payload).toBeTruthy();
    expect(JSON.stringify(payload)).toContain('"color":"#ffffff"');
    expect(JSON.stringify(payload)).toContain('"color":"#f5f5f5"');
  });

  it("includes table and code sections in the output", () => {
    const payload = markdownToNaverWorksFlexTemplate(
      [
        "| Key | Value |",
        "| --- | --- |",
        "| mode | auto-flex |",
        "",
        "```ts",
        "console.log('ok')",
        "```",
      ].join("\n"),
    );

    expect(payload).toBeTruthy();
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Table");
    expect(serialized).toContain("Code (ts)");
    expect(serialized).toContain("Key: mode | Value: auto-flex");
  });

  it("limits altText to 400 characters for NAVER WORKS flex payloads", () => {
    const payload = markdownToNaverWorksFlexTemplate(`# ${"a".repeat(500)}`);

    expect(payload).toBeTruthy();
    expect(payload?.altText.length).toBe(400);
  });
});
