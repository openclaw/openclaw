import { describe, expect, it } from "vitest";
import {
  buildProfileCompactionInstructions,
  getCompactionProfile,
  isValidProfileId,
  listCompactionProfiles,
  parseCompactCommand,
  resolveProactiveCompactionConfig,
  shouldTriggerProactiveCompaction,
} from "./compaction-profiles.js";

describe("getCompactionProfile", () => {
  it("returns known profiles", () => {
    expect(getCompactionProfile("default").id).toBe("default");
    expect(getCompactionProfile("coding").id).toBe("coding");
    expect(getCompactionProfile("conversation").id).toBe("conversation");
    expect(getCompactionProfile("research").id).toBe("research");
  });

  it("returns default for unknown profiles", () => {
    expect(getCompactionProfile("unknown" as never).id).toBe("default");
  });

  it("coding profile preserves code-related items", () => {
    const profile = getCompactionProfile("coding");
    expect(profile.instructions).toContain("file paths");
    expect(profile.instructions).toContain("Error messages");
    expect(profile.instructions).toContain("Code changes");
  });

  it("conversation profile preserves decisions", () => {
    const profile = getCompactionProfile("conversation");
    expect(profile.instructions).toContain("decisions");
    expect(profile.instructions).toContain("Action items");
  });

  it("research profile preserves data and sources", () => {
    const profile = getCompactionProfile("research");
    expect(profile.instructions).toContain("data points");
    expect(profile.instructions).toContain("Source URLs");
  });
});

describe("listCompactionProfiles", () => {
  it("returns all 4 profiles", () => {
    const profiles = listCompactionProfiles();
    expect(profiles).toHaveLength(4);
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain("default");
    expect(ids).toContain("coding");
    expect(ids).toContain("conversation");
    expect(ids).toContain("research");
  });
});

describe("isValidProfileId", () => {
  it("accepts valid profiles", () => {
    expect(isValidProfileId("default")).toBe(true);
    expect(isValidProfileId("coding")).toBe(true);
    expect(isValidProfileId("conversation")).toBe(true);
    expect(isValidProfileId("research")).toBe(true);
  });

  it("rejects invalid profiles", () => {
    expect(isValidProfileId("unknown")).toBe(false);
    expect(isValidProfileId("")).toBe(false);
  });
});

describe("resolveProactiveCompactionConfig", () => {
  it("returns defaults when no config", () => {
    const config = resolveProactiveCompactionConfig();
    expect(config.proactiveThreshold).toBe(0.65);
    expect(config.profile).toBe("default");
  });

  it("clamps threshold to valid range", () => {
    const config = resolveProactiveCompactionConfig({
      agents: { defaults: { compaction: { proactiveThreshold: 1.5 } } },
    } as never);
    expect(config.proactiveThreshold).toBeLessThanOrEqual(0.95);
  });
});

describe("shouldTriggerProactiveCompaction", () => {
  const config = resolveProactiveCompactionConfig();

  it("triggers when usage exceeds threshold", () => {
    expect(
      shouldTriggerProactiveCompaction({
        totalTokens: 70_000,
        contextWindowTokens: 100_000,
        config,
      }),
    ).toBe(true);
  });

  it("does not trigger when under threshold", () => {
    expect(
      shouldTriggerProactiveCompaction({
        totalTokens: 50_000,
        contextWindowTokens: 100_000,
        config,
      }),
    ).toBe(false);
  });

  it("does not trigger with zero tokens", () => {
    expect(
      shouldTriggerProactiveCompaction({
        totalTokens: 0,
        contextWindowTokens: 100_000,
        config,
      }),
    ).toBe(false);
  });

  it("does not trigger with zero context window", () => {
    expect(
      shouldTriggerProactiveCompaction({
        totalTokens: 70_000,
        contextWindowTokens: 0,
        config,
      }),
    ).toBe(false);
  });

  it("triggers at exact threshold", () => {
    expect(
      shouldTriggerProactiveCompaction({
        totalTokens: 65_000,
        contextWindowTokens: 100_000,
        config,
      }),
    ).toBe(true);
  });
});

describe("buildProfileCompactionInstructions", () => {
  it("includes profile instructions", () => {
    const instructions = buildProfileCompactionInstructions("coding");
    expect(instructions).toContain("file paths");
  });

  it("appends custom instructions", () => {
    const instructions = buildProfileCompactionInstructions("default", "Also preserve all URLs");
    expect(instructions).toContain("Also preserve all URLs");
    expect(instructions).toContain("Additional instructions");
  });

  it("ignores empty custom instructions", () => {
    const instructions = buildProfileCompactionInstructions("default", "   ");
    expect(instructions).not.toContain("Additional instructions");
  });
});

describe("parseCompactCommand", () => {
  it("parses empty input as default", () => {
    expect(parseCompactCommand("")).toEqual({ profile: "default" });
  });

  it("parses profile name", () => {
    expect(parseCompactCommand("coding")).toEqual({ profile: "coding" });
    expect(parseCompactCommand("research")).toEqual({ profile: "research" });
  });

  it("parses profile with instructions", () => {
    expect(parseCompactCommand("coding: keep all file paths")).toEqual({
      profile: "coding",
      instructions: "keep all file paths",
    });
  });

  it("parses colon without profile as default with instructions", () => {
    expect(parseCompactCommand(": keep all URLs")).toEqual({
      profile: "default",
      instructions: "keep all URLs",
    });
  });

  it("treats unknown words as instructions", () => {
    expect(parseCompactCommand("preserve everything")).toEqual({
      profile: "default",
      instructions: "preserve everything",
    });
  });
});
