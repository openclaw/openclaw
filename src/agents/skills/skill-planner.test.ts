import { describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  applySkillPlanTemplateSeed,
  resolveSkillPlanTemplate,
} from "../pi-embedded-runner/skills-runtime.js";
import {
  buildPlanTemplatePayload,
  DEFAULT_MAX_PLAN_TEMPLATE_STEPS,
  hasSkillPlanTemplate,
} from "./skill-planner.js";
import type { SkillPlanTemplateStep } from "./types.js";

describe("buildPlanTemplatePayload", () => {
  it("returns null for empty template", () => {
    expect(buildPlanTemplatePayload("deploy", [])).toBeNull();
  });

  it("returns null for undefined template", () => {
    expect(buildPlanTemplatePayload("deploy", undefined)).toBeNull();
    expect(buildPlanTemplatePayload("deploy")).toBeNull();
  });

  it("builds pending steps from template", () => {
    const template: SkillPlanTemplateStep[] = [
      { step: "Run tests", activeForm: "Running tests" },
      { step: "Build", activeForm: "Building" },
      { step: "Deploy" },
    ];
    const result = buildPlanTemplatePayload("deploy", template);
    expect(result).not.toBeNull();
    expect(result!.plan).toHaveLength(3);
    expect(result!.plan.every((s) => s.status === "pending")).toBe(true);
  });

  it("preserves activeForm when present", () => {
    const template: SkillPlanTemplateStep[] = [{ step: "Run tests", activeForm: "Running tests" }];
    const result = buildPlanTemplatePayload("deploy", template);
    expect(result!.plan[0].activeForm).toBe("Running tests");
  });

  it("omits activeForm when absent", () => {
    const template: SkillPlanTemplateStep[] = [{ step: "Deploy" }];
    const result = buildPlanTemplatePayload("deploy", template);
    expect(result!.plan[0]).not.toHaveProperty("activeForm");
  });

  it("includes skill name in explanation", () => {
    const result = buildPlanTemplatePayload("release-cut", [{ step: "Tag" }]);
    expect(result!.explanation).toContain("release-cut");
  });

  it("dedupes duplicate step text within a single template (first wins)", () => {
    const template: SkillPlanTemplateStep[] = [
      { step: "A", activeForm: "Doing A" },
      { step: "B" },
      { step: "A", activeForm: "Doing A again" }, // duplicate of step "A"
      { step: "C" },
    ];
    const result = buildPlanTemplatePayload("multi", template);
    expect(result!.plan).toHaveLength(3);
    expect(result!.plan.map((p) => p.step)).toEqual(["A", "B", "C"]);
    // First wins — keeps the original activeForm.
    expect(result!.plan[0].activeForm).toBe("Doing A");
    expect(result!.droppedDuplicates).toEqual(["A"]);
  });

  it("returns null when all entries are duplicates of an empty pre-set (impossible) — defensive case", () => {
    // After dedup the template is non-empty, so this case still produces a payload.
    // This sanity test ensures dedup of a 1-element array with no duplicates yields a payload.
    const result = buildPlanTemplatePayload("solo", [{ step: "Lone" }]);
    expect(result).not.toBeNull();
    expect(result!.plan).toHaveLength(1);
  });

  it("truncates templates exceeding maxSteps and flags `truncated: true`", () => {
    const template: SkillPlanTemplateStep[] = Array.from({ length: 100 }, (_, i) => ({
      step: `Step ${i}`,
    }));
    const result = buildPlanTemplatePayload("big", template, { maxSteps: 10 });
    expect(result!.plan).toHaveLength(10);
    expect(result!.truncated).toBe(true);
    expect(result!.maxSteps).toBe(10);
  });

  it("uses DEFAULT_MAX_PLAN_TEMPLATE_STEPS when maxSteps not set", () => {
    const template: SkillPlanTemplateStep[] = Array.from(
      { length: DEFAULT_MAX_PLAN_TEMPLATE_STEPS + 5 },
      (_, i) => ({ step: `Step ${i}` }),
    );
    const result = buildPlanTemplatePayload("big", template);
    expect(result!.plan).toHaveLength(DEFAULT_MAX_PLAN_TEMPLATE_STEPS);
    expect(result!.truncated).toBe(true);
  });

  it("does not flag truncation for templates within bounds", () => {
    const template: SkillPlanTemplateStep[] = [{ step: "A" }, { step: "B" }];
    const result = buildPlanTemplatePayload("small", template);
    expect(result!.truncated).toBeUndefined();
    expect(result!.droppedDuplicates).toBeUndefined();
  });
});

describe("hasSkillPlanTemplate", () => {
  it("returns false for undefined metadata", () => {
    expect(hasSkillPlanTemplate(undefined)).toBe(false);
  });

  it("returns false for empty planTemplate", () => {
    expect(hasSkillPlanTemplate({ planTemplate: [] })).toBe(false);
  });

  it("returns true for non-empty planTemplate", () => {
    expect(hasSkillPlanTemplate({ planTemplate: [{ step: "x" }] })).toBe(true);
  });
});

describe("resolveSkillPlanTemplate", () => {
  it("returns null when no entries have a plan template", () => {
    const entries = [
      { skill: { name: "deploy" }, metadata: {} },
      { skill: { name: "lint" }, metadata: { planTemplate: [] } },
    ] as Parameters<typeof resolveSkillPlanTemplate>[0];
    expect(resolveSkillPlanTemplate(entries)).toBeNull();
  });

  it("returns the payload + skillName for a single template", () => {
    const entries = [
      { skill: { name: "deploy" }, metadata: {} },
      {
        skill: { name: "release" },
        metadata: { planTemplate: [{ step: "Tag release" }] },
      },
    ] as Parameters<typeof resolveSkillPlanTemplate>[0];
    const result = resolveSkillPlanTemplate(entries);
    expect(result).not.toBeNull();
    expect(result!.skillName).toBe("release");
    expect(result!.rejected).toEqual([]);
    expect(result!.payload.plan[0].step).toBe("Tag release");
    expect(result!.payload.explanation).toContain("release");
  });

  it("returns null for empty entries array", () => {
    expect(resolveSkillPlanTemplate([])).toBeNull();
  });

  it("on collision picks alpha-first skill and lists the rest in `rejected`", () => {
    const entries = [
      {
        skill: { name: "release" },
        metadata: { planTemplate: [{ step: "Tag release" }] },
      },
      {
        skill: { name: "deploy" },
        metadata: { planTemplate: [{ step: "Push to staging" }] },
      },
      {
        skill: { name: "audit" },
        metadata: { planTemplate: [{ step: "Run audit" }] },
      },
    ] as Parameters<typeof resolveSkillPlanTemplate>[0];

    const result = resolveSkillPlanTemplate(entries);
    expect(result!.skillName).toBe("audit");
    expect(result!.rejected).toEqual(["deploy", "release"]);
    expect(result!.payload.plan[0].step).toBe("Run audit");
  });

  it("respects skills.limits.maxPlanTemplateSteps from config", () => {
    const entries = [
      {
        skill: { name: "big" },
        metadata: {
          planTemplate: Array.from({ length: 100 }, (_, i) => ({ step: `S${i}` })),
        },
      },
    ] as Parameters<typeof resolveSkillPlanTemplate>[0];

    const result = resolveSkillPlanTemplate(entries, {
      skills: { limits: { maxPlanTemplateSteps: 5 } },
    });
    expect(result!.payload.plan).toHaveLength(5);
    expect(result!.payload.truncated).toBe(true);
  });
});

describe("applySkillPlanTemplateSeed", () => {
  it("returns null when runId is missing", () => {
    const result = applySkillPlanTemplateSeed({
      entries: [
        {
          skill: { name: "x" },
          metadata: { planTemplate: [{ step: "Y" }] },
        },
      ] as Parameters<typeof applySkillPlanTemplateSeed>[0]["entries"],
    });
    expect(result).toBeNull();
  });

  it("returns null when no skill carries a template", () => {
    resetAgentEventsForTest();
    const result = applySkillPlanTemplateSeed({
      runId: "run-1",
      entries: [{ skill: { name: "x" }, metadata: {} }] as Parameters<
        typeof applySkillPlanTemplateSeed
      >[0]["entries"],
    });
    expect(result).toBeNull();
  });

  it("skips seeding when existingPlanSteps is non-empty (idempotency)", () => {
    resetAgentEventsForTest();
    const result = applySkillPlanTemplateSeed({
      runId: "run-2",
      entries: [
        {
          skill: { name: "x" },
          metadata: { planTemplate: [{ step: "Y" }] },
        },
      ] as Parameters<typeof applySkillPlanTemplateSeed>[0]["entries"],
      existingPlanSteps: [{ step: "Already planned" }],
    });
    expect(result).toBeNull();
  });

  it("forwards seed event to onAgentEvent callback (Codex P2 r3096399082/r3096435183)", () => {
    // Adversarial regression: callback-only consumers (e.g. auto-reply
    // pipeline) need to see the seed event the same way they see other
    // plan updates. Prior implementation only called global emitAgentPlanEvent.
    resetAgentEventsForTest();
    const callbackEvents: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const result = applySkillPlanTemplateSeed({
      runId: "run-cb",
      sessionKey: "session-cb",
      entries: [
        {
          skill: { name: "release" },
          metadata: { planTemplate: [{ step: "Tag" }] },
        },
      ] as Parameters<typeof applySkillPlanTemplateSeed>[0]["entries"],
      onAgentEvent: (evt) => {
        callbackEvents.push({ stream: evt.stream, data: evt.data as Record<string, unknown> });
      },
    });
    expect(result).not.toBeNull();
    expect(callbackEvents).toHaveLength(1);
    expect(callbackEvents[0].stream).toBe("plan");
    expect(callbackEvents[0].data).toMatchObject({
      title: 'Plan seeded from skill "release"',
      source: "skill_plan_template",
    });
  });

  it("filters out ineligible skills before collision resolution (Codex P2 r3096399074)", () => {
    // Adversarial regression: a disabled skill with a planTemplate would
    // win the alpha-first collision and seed an unrelated plan even though
    // the skill itself is excluded from the runtime prompt. The seeder now
    // applies shouldIncludeSkill() filtering before resolving the winner.
    resetAgentEventsForTest();
    const result = applySkillPlanTemplateSeed({
      runId: "run-filter",
      entries: [
        {
          // Alphabetically first BUT disabled in config.
          skill: { name: "alpha-disabled" },
          metadata: { planTemplate: [{ step: "WrongPlan" }] },
        },
        {
          skill: { name: "beta-active" },
          metadata: { planTemplate: [{ step: "RightPlan" }] },
        },
      ] as Parameters<typeof applySkillPlanTemplateSeed>[0]["entries"],
      config: {
        skills: {
          entries: {
            "alpha-disabled": { enabled: false },
          },
        },
      },
    });
    // beta-active should win because alpha-disabled was filtered out first.
    expect(result).not.toBeNull();
    expect(result!.skillName).toBe("beta-active");
  });

  it("emits agent_plan_event and returns summary on successful seed", async () => {
    resetAgentEventsForTest();
    const { onAgentEvent, registerAgentRunContext } = await import("../../infra/agent-events.js");
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const off = onAgentEvent((evt) => events.push({ stream: evt.stream, data: evt.data }));

    try {
      registerAgentRunContext("run-seed", { sessionKey: "session-seed" });
      const result = applySkillPlanTemplateSeed({
        runId: "run-seed",
        sessionKey: "session-seed",
        entries: [
          {
            skill: { name: "release" },
            metadata: {
              planTemplate: [{ step: "Tag" }, { step: "Publish" }],
            },
          },
        ] as Parameters<typeof applySkillPlanTemplateSeed>[0]["entries"],
      });

      expect(result).not.toBeNull();
      expect(result!.skillName).toBe("release");
      expect(result!.emittedSteps).toBe(2);
      expect(result!.rejected).toEqual([]);

      const planEvents = events.filter((e) => e.stream === "plan");
      expect(planEvents).toHaveLength(1);
      expect(planEvents[0].data).toMatchObject({
        phase: "update",
        title: 'Plan seeded from skill "release"',
        steps: ["Tag", "Publish"],
        source: "skill_plan_template",
      });
    } finally {
      off();
    }
  });

  it("warns about collision when multiple skills carry templates", async () => {
    resetAgentEventsForTest();
    const warnSpy = vi.spyOn(await import("../../logger.js"), "logWarn");
    try {
      const result = applySkillPlanTemplateSeed({
        runId: "run-collision",
        entries: [
          {
            skill: { name: "release" },
            metadata: { planTemplate: [{ step: "Tag" }] },
          },
          {
            skill: { name: "audit" },
            metadata: { planTemplate: [{ step: "Run audit" }] },
          },
        ] as Parameters<typeof applySkillPlanTemplateSeed>[0]["entries"],
      });
      expect(result!.skillName).toBe("audit");
      expect(result!.rejected).toEqual(["release"]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("skill_plan_template_collision"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("falls back to snapshot.resolvedPlanTemplates when entries is empty (snapshot-backed run path)", async () => {
    // Adversarial regression (Codex P1 on PR #67541):
    // resolveEmbeddedRunSkillEntries returns skillEntries=[] whenever a
    // snapshot is present, which is the main production run path. The
    // seeder must therefore fall back to snapshot.resolvedPlanTemplates
    // so it doesn't silently no-op for normal sessions.
    resetAgentEventsForTest();
    const { onAgentEvent } = await import("../../infra/agent-events.js");
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const off = onAgentEvent((evt) => events.push({ stream: evt.stream, data: evt.data }));

    try {
      const result = applySkillPlanTemplateSeed({
        runId: "run-snapshot",
        sessionKey: "session-snapshot",
        entries: [], // empty — snapshot path
        skillsSnapshot: {
          prompt: "",
          skills: [{ name: "release" }],
          resolvedPlanTemplates: [
            {
              skillName: "release",
              planTemplate: [{ step: "Tag" }, { step: "Publish" }],
            },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.skillName).toBe("release");
      expect(result!.emittedSteps).toBe(2);

      const planEvents = events.filter((e) => e.stream === "plan");
      expect(planEvents).toHaveLength(1);
      expect(planEvents[0].data).toMatchObject({
        steps: ["Tag", "Publish"],
        source: "skill_plan_template",
      });
    } finally {
      off();
    }
  });

  it("warns about truncation and dropped duplicates", async () => {
    resetAgentEventsForTest();
    const warnSpy = vi.spyOn(await import("../../logger.js"), "logWarn");
    try {
      const template: SkillPlanTemplateStep[] = [
        { step: "A" },
        { step: "B" },
        { step: "A" }, // dup
        { step: "C" },
      ];
      const result = applySkillPlanTemplateSeed({
        runId: "run-warn",
        entries: [
          {
            skill: { name: "x" },
            metadata: { planTemplate: template },
          },
        ] as Parameters<typeof applySkillPlanTemplateSeed>[0]["entries"],
        config: { skills: { limits: { maxPlanTemplateSteps: 2 } } },
      });
      expect(result!.droppedDuplicates).toEqual(["A"]);
      expect(result!.truncated).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("skill_plan_template_duplicates"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("skill_plan_template_truncated"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
