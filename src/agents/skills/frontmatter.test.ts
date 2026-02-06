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
  it("parses install uninstall metadata", () => {
    const metadata = resolveOpenClawMetadata({
      metadata:
        '{"openclaw":{"install":[{"id":"brew","kind":"brew","formula":"gog","bins":["gog"],"uninstall":{"kind":"brew","formula":"gog","bins":["gog"],"label":"Uninstall gog (brew)"}}]}}',
    });

    expect(metadata?.install).toHaveLength(1);
    expect(metadata?.install?.[0]?.uninstall?.kind).toBe("brew");
    expect(metadata?.install?.[0]?.uninstall?.label).toBe("Uninstall gog (brew)");
  });
});
