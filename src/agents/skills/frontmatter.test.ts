import { describe, expect, it } from "vitest";
import { resolveOpenClawMetadata, resolveSkillInvocationPolicy } from "./frontmatter.js";

describe("resolveSkillInvocationPolicy", () => {
  it("defaults to enabled behaviors", () => {
    const policy = resolveSkillInvocationPolicy({});
    expect(policy.userInvocable).toBe(true);
    expect(policy.disableModelInvocation).toBe(false);
  });

  it("parses frontmatter boolean strings", () => {
    const policy = resolveSkillInvocationPolicy({
      "user-invocable": "no",
      "disable-model-invocation": "yes",
    });
    expect(policy.userInvocable).toBe(false);
    expect(policy.disableModelInvocation).toBe(true);
  });
});

describe("resolveOpenClawMetadata", () => {
  it("extracts repository from metadata", () => {
    const frontmatter = {
      metadata: JSON.stringify({
        openclaw: {
          repository: "https://github.com/example/skill-repo",
        },
      }),
    };

    const result = resolveOpenClawMetadata(frontmatter);
    expect(result).toBeDefined();
    expect(result?.repository).toBe("https://github.com/example/skill-repo");
  });

  it("extracts homepage and repository together", () => {
    const frontmatter = {
      metadata: JSON.stringify({
        openclaw: {
          homepage: "https://example.com",
          repository: "https://github.com/example/skill-repo",
        },
      }),
    };

    const result = resolveOpenClawMetadata(frontmatter);
    expect(result?.homepage).toBe("https://example.com");
    expect(result?.repository).toBe("https://github.com/example/skill-repo");
  });

  it("returns undefined repository when not present", () => {
    const frontmatter = {
      metadata: JSON.stringify({
        openclaw: {
          emoji: "🔧",
        },
      }),
    };

    const result = resolveOpenClawMetadata(frontmatter);
    expect(result).toBeDefined();
    expect(result?.repository).toBeUndefined();
  });

  it("returns undefined for missing metadata", () => {
    const frontmatter = { name: "test-skill" };
    const result = resolveOpenClawMetadata(frontmatter);
    expect(result).toBeUndefined();
  });
});
