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
        const steps: PlanStepForRender[] = [
          { step: "Deploy", status: "in_progress" },
        ];
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
