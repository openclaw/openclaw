import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SkillEntry } from "./types.js";

vi.mock("../../shared/config-eval.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/config-eval.js")>();
  return {
    ...actual,
    evaluateRuntimeEligibility: vi.fn(),
  };
});

import * as configEvalModule from "../../shared/config-eval.js";
import { shouldIncludeSkill } from "./config.js";

const evaluateRuntimeEligibilityMock = vi.mocked(configEvalModule.evaluateRuntimeEligibility);

afterEach(() => {
  vi.resetAllMocks();
});

function createSkillEntry(metadata?: SkillEntry["metadata"]): SkillEntry {
  return {
    skill: { name: "test-skill" } as unknown as SkillEntry["skill"],
    frontmatter: {},
    metadata,
  };
}

function createConfigForSkill(
  skillKey: string,
  skillConfig: NonNullable<OpenClawConfig["skills"]>["entries"][string],
): OpenClawConfig {
  return {
    skills: {
      entries: {
        [skillKey]: skillConfig,
      },
    },
  };
}

describe("skills/config shouldIncludeSkill", () => {
  it("returns false when enabled is explicitly false without evaluating runtime eligibility", () => {
    const entry = createSkillEntry();
    const config = createConfigForSkill("test-skill", { enabled: false });

    const result = shouldIncludeSkill({ entry, config });

    expect(result).toBe(false);
    expect(evaluateRuntimeEligibilityMock).not.toHaveBeenCalled();
  });

  it("returns true when enabled is explicitly true without evaluating runtime eligibility", () => {
    const entry = createSkillEntry({
      requires: {
        bins: ["missing-cli"],
      },
    });
    const config = createConfigForSkill("test-skill", { enabled: true });

    const result = shouldIncludeSkill({ entry, config });

    expect(result).toBe(true);
    expect(evaluateRuntimeEligibilityMock).not.toHaveBeenCalled();
  });

  it("falls through to runtime eligibility when enabled is not set", () => {
    evaluateRuntimeEligibilityMock.mockReturnValue(true);

    const entry = createSkillEntry();
    const config = createConfigForSkill("test-skill", {});

    const result = shouldIncludeSkill({ entry, config });

    expect(result).toBe(true);
    expect(evaluateRuntimeEligibilityMock).toHaveBeenCalledTimes(1);
  });
});

