import { describe, expect, it } from "vitest";
import { validateConfigDraft } from "./validation.ts";

describe("validateConfigDraft", () => {
  it("accepts empty drafts", () => {
    const result = validateConfigDraft({});
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("collects issues by path and section", () => {
    const result = validateConfigDraft({
      gateway: {
        auth: {
          token: 123,
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issuesByPath["gateway.auth.token"]?.length).toBeGreaterThan(0);
    expect(result.sectionErrorCounts.gateway).toBeGreaterThan(0);
  });

  it("tracks root-level schema issues", () => {
    const result = validateConfigDraft({
      __unexpected__: true,
    });

    expect(result.valid).toBe(false);
    expect(result.sectionErrorCounts.root).toBeGreaterThan(0);
  });
});
