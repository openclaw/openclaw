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

  it("plaintext renderPlanWithHeader: neutralizes @everyone in TITLE (Codex P2 r3095517064)", () => {
    // Adversarial regression: prior implementation neutralized step labels
    // but emitted the title verbatim. A model-derived title like
    // `@everyone release plan` would still trigger mentions.
    const steps: PlanStepForRender[] = [{ step: "Tag release", status: "pending" }];
    const result = renderPlanWithHeader("@everyone release plan", steps, "plaintext");
    expect(result).not.toMatch(/@everyone\b/);
    expect(result).toContain("release plan");
  });

  it("plaintext renderPlanWithHeader: neutralizes @channel and @here in TITLE", () => {
    const steps: PlanStepForRender[] = [{ step: "S", status: "pending" }];
    const result1 = renderPlanWithHeader("@channel deploy now", steps, "plaintext");
    expect(result1).not.toMatch(/@channel\b/);

    const result2 = renderPlanWithHeader("@here urgent", steps, "plaintext");
    expect(result2).not.toMatch(/@here\b/);
  });

  // PR-11 deep-dive review B1: pre-fix, neutralizeMentions only fired
  // for plaintext + slack-mrkdwn. Markdown (Discord/Mattermost/Matrix)
  // and HTML (Telegram) leaked @everyone/@here/@channel + Discord
  // raw-mention syntax. These tests pin the post-fix behavior.
  it("markdown: neutralizes @channel/@here/@everyone in step text (review B1)", () => {
    const steps: PlanStepForRender[] = [
      { step: "Notify @channel about deploy", status: "pending" },
      { step: "@here review needed", status: "pending" },
      { step: "@everyone please respond", status: "pending" },
    ];
    const result = renderPlanChecklist(steps, "markdown");
    expect(result).not.toMatch(/@channel\b/);
    expect(result).not.toMatch(/@here\b/);
    expect(result).not.toMatch(/@everyone\b/);
  });

  it("markdown: neutralizes Discord raw mentions <@123> / <@!123> / <@&123> (review B1)", () => {
    const steps: PlanStepForRender[] = [
      { step: "Ping <@!12345> for review", status: "pending" },
      { step: "Notify role <@&98765>", status: "pending" },
    ];
    const result = renderPlanChecklist(steps, "markdown");
    // The `<@` sequence must be broken with U+200B so Discord's parser
    // doesn't treat it as a mention.
    expect(result).not.toContain("<@!12345>");
    expect(result).not.toContain("<@&98765>");
    expect(result).toContain("<\u200B@");
  });

  it("html: neutralizes @channel/@here/@everyone in step text (review B1)", () => {
    const steps: PlanStepForRender[] = [
      { step: "Notify @channel about deploy", status: "pending" },
      { step: "@everyone please respond", status: "pending" },
    ];
    const result = renderPlanChecklist(steps, "html");
    expect(result).not.toMatch(/@channel\b/);
    expect(result).not.toMatch(/@everyone\b/);
  });

  it("markdown renderPlanWithHeader: neutralizes @everyone in TITLE (review B1)", () => {
    const steps: PlanStepForRender[] = [{ step: "Tag release", status: "pending" }];
    const result = renderPlanWithHeader("@everyone release plan", steps, "markdown");
    expect(result).not.toMatch(/@everyone\b/);
    expect(result).toContain("release plan");
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

  // PR-9 Wave B1: closure-gate rendering — acceptance criteria appear
  // as a nested checklist beneath each step.
  describe("closure-gate criteria rendering (Wave B1)", () => {
    const STEP_WITH_CRITERIA: PlanStepForRender = {
      step: "Provision VM",
      status: "in_progress",
      acceptanceCriteria: ["VM is reachable via SSH", "cortex_owner is set"],
      verifiedCriteria: ["VM is reachable via SSH"],
    };

    it("markdown: renders verified as [x] and unverified as [ ] under the step", () => {
      const out = renderPlanChecklist([STEP_WITH_CRITERIA], "markdown");
      expect(out).toContain("- [x] VM is reachable via SSH");
      expect(out).toContain("- [ ] cortex\\_owner is set"); // markdown escape on _
    });

    it("plaintext: renders verified [x] and unverified [ ] under the step", () => {
      const out = renderPlanChecklist([STEP_WITH_CRITERIA], "plaintext");
      const lines = out.split("\n");
      expect(lines.some((l) => l.includes("[x] VM is reachable via SSH"))).toBe(true);
      expect(lines.some((l) => l.includes("[ ] cortex_owner is set"))).toBe(true);
    });

    it("html: renders verified ✓ and unverified ◻ under the step", () => {
      const out = renderPlanChecklist([STEP_WITH_CRITERIA], "html");
      expect(out).toContain("✓ VM is reachable via SSH");
      expect(out).toContain("◻ cortex_owner is set");
    });

    it("slack-mrkdwn: renders verified ✓ and unverified ◻", () => {
      const out = renderPlanChecklist([STEP_WITH_CRITERIA], "slack-mrkdwn");
      expect(out).toContain("✓ VM is reachable via SSH");
      // Slack escapes `_` → fullwidth `＿` (avoid italic interpretation).
      expect(out).toMatch(/◻ cortex.owner is set/);
    });

    it("empty acceptanceCriteria → no nested lines (backwards-compat)", () => {
      const step: PlanStepForRender = {
        step: "Simple step",
        status: "completed",
        acceptanceCriteria: [],
      };
      const out = renderPlanChecklist([step], "markdown");
      expect(out.split("\n")).toHaveLength(1);
    });

    it("undefined verifiedCriteria → all entries render as unverified", () => {
      const step: PlanStepForRender = {
        step: "X",
        status: "in_progress",
        acceptanceCriteria: ["a", "b", "c"],
      };
      const out = renderPlanChecklist([step], "markdown");
      expect(out).toContain("- [ ] a");
      expect(out).toContain("- [ ] b");
      expect(out).toContain("- [ ] c");
      expect(out).not.toContain("- [x]");
    });

    it("criteria text with newlines is collapsed to space", () => {
      const step: PlanStepForRender = {
        step: "X",
        status: "in_progress",
        acceptanceCriteria: ["line1\nline2\rline3"],
      };
      const out = renderPlanChecklist([step], "markdown");
      expect(out).toContain("line1 line2 line3");
      expect(out).not.toContain("\nline2");
    });

    it("html criteria escapes user content", () => {
      const step: PlanStepForRender = {
        step: "X",
        status: "in_progress",
        acceptanceCriteria: [`<tag>"quoted"`],
      };
      const out = renderPlanChecklist([step], "html");
      expect(out).toContain("&lt;tag&gt;");
      expect(out).toContain("&quot;quoted&quot;");
    });
  });
});
