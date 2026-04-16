import { describe, expect, it } from "vitest";
import {
  renderPlanChecklist,
  renderPlanWithHeader,
  type PlanStepForRender,
  type PlanRenderFormat,
} from "./plan-render.js";

const SAMPLE_STEPS: PlanStepForRender[] = [
  { step: "Run tests", status: "completed" },
  { step: "Build artifacts", status: "in_progress", activeForm: "Building artifacts" },
  { step: "Deploy to staging", status: "pending" },
  { step: "Fix broken migration", status: "cancelled" },
];

describe("renderPlanChecklist", () => {
  it("returns empty string for empty steps", () => {
    expect(renderPlanChecklist([], "markdown")).toBe("");
  });

  const formats: PlanRenderFormat[] = ["html", "markdown", "plaintext", "slack-mrkdwn"];

  for (const format of formats) {
    describe(`format: ${format}`, () => {
      it("renders all four statuses", () => {
        const result = renderPlanChecklist(SAMPLE_STEPS, format);
        const lines = result.split("\n");
        expect(lines).toHaveLength(4);
      });

      it("uses activeForm for in_progress steps", () => {
        const result = renderPlanChecklist(SAMPLE_STEPS, format);
        expect(result).toContain("Building artifacts");
        expect(result).not.toContain("Build artifacts");
      });

      it("falls back to step text when activeForm is absent", () => {
        const steps: PlanStepForRender[] = [{ step: "Deploy", status: "in_progress" }];
        const result = renderPlanChecklist(steps, format);
        expect(result).toContain("Deploy");
      });
    });
  }

  it("html: escapes HTML in step text", () => {
    const steps: PlanStepForRender[] = [
      { step: "Check <script>alert(1)</script>", status: "pending" },
    ];
    const result = renderPlanChecklist(steps, "html");
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("html: renders completed with ✅", () => {
    const result = renderPlanChecklist(SAMPLE_STEPS, "html");
    expect(result).toMatch(/✅.*Run tests/);
  });

  it("strips newlines from step labels", () => {
    const steps: PlanStepForRender[] = [
      { step: "Run tests\nthen check results", status: "pending" },
      { step: "Build\r\nartifacts", status: "in_progress", activeForm: "Building\nartifacts" },
    ];
    for (const format of ["html", "markdown", "plaintext", "slack-mrkdwn"] as const) {
      const result = renderPlanChecklist(steps, format);
      expect(result).not.toContain("\n ");
      expect(result).not.toContain("\r");
      expect(result).toContain("Run tests then check results");
      expect(result).toContain("Building artifacts");
    }
  });

  it("html: renders cancelled with strikethrough", () => {
    const result = renderPlanChecklist(SAMPLE_STEPS, "html");
    expect(result).toMatch(/❌.*<s>.*Fix broken migration.*<\/s>/);
  });

  it("markdown: renders checkboxes", () => {
    const result = renderPlanChecklist(SAMPLE_STEPS, "markdown");
    expect(result).toContain("- [x] Run tests");
    expect(result).toContain("- [>] **Building artifacts**");
    expect(result).toContain("- [ ] Deploy to staging");
    expect(result).toContain("- [~] ~~Fix broken migration~~");
  });

  it("plaintext: renders ASCII markers", () => {
    const result = renderPlanChecklist(SAMPLE_STEPS, "plaintext");
    expect(result).toContain("[x] Run tests");
    expect(result).toContain("[>] Building artifacts");
    expect(result).toContain("[ ] Deploy to staging");
    expect(result).toContain("[~] Fix broken migration");
  });

  it("slack-mrkdwn: renders Slack formatting", () => {
    const result = renderPlanChecklist(SAMPLE_STEPS, "slack-mrkdwn");
    expect(result).toContain("✅ Run tests");
    expect(result).toContain("⏳ *Building artifacts*");
    expect(result).toContain("⬚ Deploy to staging");
    expect(result).toContain("❌ ~Fix broken migration~");
  });

  it("slack-mrkdwn: escapes control characters and mention tokens", () => {
    const steps: PlanStepForRender[] = [
      { step: "Check *bold* and _italic_ text", status: "pending" },
      { step: "Handle <@U123> mention and <!here>", status: "pending" },
      { step: "Test `backtick` and ~strike~ and @channel", status: "pending" },
    ];
    const result = renderPlanChecklist(steps, "slack-mrkdwn");
    // Must not contain raw Slack formatting chars
    expect(result).not.toContain("<@U123>");
    expect(result).not.toContain("<!here>");
    expect(result).not.toMatch(/(?<!\u2217)\*(?!\u2217)/); // no raw asterisks
    expect(result).not.toContain("@channel");
  });

  it("slack-mrkdwn: title escaping in renderPlanWithHeader", () => {
    const steps: PlanStepForRender[] = [{ step: "Step one", status: "pending" }];
    const result = renderPlanWithHeader("Plan *with* <@mention>", steps, "slack-mrkdwn");
    expect(result).not.toContain("<@mention>");
    expect(result).toContain("Plan");
  });
});

describe("renderPlanWithHeader", () => {
  it("renders header + checklist for each format", () => {
    for (const format of ["html", "markdown", "plaintext", "slack-mrkdwn"] as const) {
      const result = renderPlanWithHeader("Agent Plan", SAMPLE_STEPS, format);
      expect(result).toContain("Agent Plan");
      expect(result.split("\n").length).toBeGreaterThan(4);
    }
  });

  it("returns empty string when no steps", () => {
    expect(renderPlanWithHeader("Empty", [], "markdown")).toBe("");
  });

  it("html header uses bold", () => {
    const result = renderPlanWithHeader("My Plan", SAMPLE_STEPS, "html");
    expect(result).toMatch(/^<b>My Plan<\/b>/);
  });

  it("markdown header uses h3", () => {
    const result = renderPlanWithHeader("My Plan", SAMPLE_STEPS, "markdown");
    expect(result).toMatch(/^### My Plan/);
  });
});

describe("markdown injection hardening", () => {
  it("escapes backticks in step text (no code spans from user input)", () => {
    const steps: PlanStepForRender[] = [{ step: "Deploy `rm -rf /`", status: "pending" }];
    const md = renderPlanChecklist(steps, "markdown");
    // No raw backticks left that would form a code span
    expect(md).not.toMatch(/[^\\]`/);
    // Backticks are escaped
    expect(md).toContain("\\`");
  });

  it("escapes link syntax (no clickable links from user input)", () => {
    const steps: PlanStepForRender[] = [
      { step: "Click [here](https://evil.example)", status: "pending" },
    ];
    const md = renderPlanChecklist(steps, "markdown");
    expect(md).not.toMatch(/\[here\]\(https/);
    expect(md).toContain("\\[here\\]");
  });

  it("escapes emphasis markers (no bold/italic from user input)", () => {
    const steps: PlanStepForRender[] = [{ step: "*shouting* and _whispering_", status: "pending" }];
    const md = renderPlanChecklist(steps, "markdown");
    expect(md).not.toMatch(/\*shouting\*/);
    expect(md).toContain("\\*shouting\\*");
  });

  it("escapes heading markers (no inline h1 from user input)", () => {
    const steps: PlanStepForRender[] = [{ step: "# Important note", status: "pending" }];
    const md = renderPlanChecklist(steps, "markdown");
    expect(md).toContain("\\# Important note");
  });

  it("cancelled status with markdown injection: both strikethrough and escaping applied", () => {
    const steps: PlanStepForRender[] = [{ step: "Deploy `prod`", status: "cancelled" }];
    const md = renderPlanChecklist(steps, "markdown");
    expect(md).toContain("~~Deploy \\`prod\\`~~");
  });
});

describe("mention neutralization", () => {
  it("plaintext: neutralizes @channel", () => {
    const steps: PlanStepForRender[] = [
      { step: "Notify @channel about deploy", status: "pending" },
    ];
    const result = renderPlanChecklist(steps, "plaintext");
    expect(result).not.toContain("@channel");
    expect(result).toContain("@\uFE6Bchannel");
  });

  it("plaintext: neutralizes @here and @everyone", () => {
    const steps: PlanStepForRender[] = [
      { step: "@here review needed", status: "pending" },
      { step: "@everyone please respond", status: "pending" },
    ];
    const result = renderPlanChecklist(steps, "plaintext");
    expect(result).not.toMatch(/@here\b/);
    expect(result).not.toMatch(/@everyone\b/);
  });

  it("plaintext: leaves regular @mentions of users alone", () => {
    const steps: PlanStepForRender[] = [
      { step: "Assign @alice to investigate", status: "pending" },
    ];
    const result = renderPlanChecklist(steps, "plaintext");
    expect(result).toContain("@alice");
  });
});

describe("activeForm fallback", () => {
  it("uses step text when activeForm is whitespace-only", () => {
    const steps: PlanStepForRender[] = [
      { step: "Run tests", status: "in_progress", activeForm: "   " },
    ];
    const result = renderPlanChecklist(steps, "markdown");
    expect(result).toContain("Run tests");
    expect(result).not.toContain("   ");
  });

  it("uses step text when activeForm is empty string", () => {
    const steps: PlanStepForRender[] = [
      { step: "Build artifacts", status: "in_progress", activeForm: "" },
    ];
    const result = renderPlanChecklist(steps, "markdown");
    expect(result).toContain("Build artifacts");
  });

  it("uses activeForm when present and non-empty", () => {
    const steps: PlanStepForRender[] = [
      { step: "Run tests", status: "in_progress", activeForm: "Running tests" },
    ];
    const result = renderPlanChecklist(steps, "markdown");
    expect(result).toContain("Running tests");
    expect(result).not.toContain("Run tests");
  });
});

describe("HTML escaping", () => {
  it("escapes quotes in addition to angle brackets and ampersand", () => {
    const steps: PlanStepForRender[] = [
      { step: `Quote: "double" and 'single' & <tag>`, status: "pending" },
    ];
    const html = renderPlanChecklist(steps, "html");
    expect(html).toContain("&quot;");
    expect(html).toContain("&#39;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;tag&gt;");
  });
});
