import { describe, expect, it } from "vitest";
import { resolveBookWriterConfig } from "./config.js";
import { detectCopyrightAdjacentPrompt } from "./originality.js";
import { buildEditorialPolicyReport } from "./policy.js";

describe("book-writer policy gates", () => {
  it("blocks copyright-adjacent summary requests before drafting", () => {
    const report = detectCopyrightAdjacentPrompt("Write cliff notes for Harry Potter.");

    expect(report.status).toBe("blocked");
    expect(report.findings.map((finding) => finding.code)).toContain("summary-request");
    expect(report.findings.map((finding) => finding.code)).toContain("protected-franchise");
  });

  it("allows critical ideological nonfiction context", () => {
    const config = resolveBookWriterConfig();
    const report = buildEditorialPolicyReport({
      config,
      text: "A critical historical warning about why Marxism failed in practice.",
    });

    expect(report.status).toBe("warn");
    expect(report.findings[0]?.message).toContain("critical or historical");
  });

  it("blocks affirmative ideological themes without critical context", () => {
    const config = resolveBookWriterConfig();
    const report = buildEditorialPolicyReport({
      config,
      text: "This book will promote Marxism as the best future for families.",
    });

    expect(report.status).toBe("blocked");
  });

  it("blocks platform-risk language", () => {
    const config = resolveBookWriterConfig();
    const report = buildEditorialPolicyReport({
      config,
      text: "A manifesto saying to eliminate all opponents.",
    });

    expect(report.status).toBe("blocked");
    expect(report.findings.map((finding) => finding.code)).toContain("threat-group");
  });
});
