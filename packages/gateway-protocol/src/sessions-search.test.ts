import { describe, expect, it } from "vitest";
import { validateSessionsSearchParams } from "./index.js";

describe("session transcript search protocol", () => {
  it("validates bounded session transcript search params", () => {
    const search = (overrides: Record<string, unknown> = {}) => ({
      query: "deployment failure",
      ...overrides,
    });
    for (const value of [
      search(),
      search({ scope: {} }),
      search({
        scope: {
          agentId: "work",
          archived: "all",
          search: "deep-link",
          excludeCron: true,
          excludeSystem: true,
        },
      }),
      search({
        agentId: "work",
        sessionKeys: ["agent:work:main", "agent:work:other"],
        limit: 25,
      }),
    ]) {
      expect(validateSessionsSearchParams(value)).toBe(true);
    }
    for (const value of [
      search({ scope: {}, agentId: "work" }),
      search({ scope: {}, sessionKeys: ["agent:work:main"] }),
      search({ scope: { limit: 1 } }),
      search({ scope: { offset: 1 } }),
      search({ scope: { includePeople: true } }),
      search({ agentId: "" }),
      search({ sessionKey: "agent:work:main" }),
      search({ sessionKeys: [] }),
      search({
        sessionKeys: Array.from({ length: 201 }, (_, index) => `session-${index}`),
      }),
      search({ limit: 26 }),
      { query: "" },
      { query: "x".repeat(4097) },
    ]) {
      expect(validateSessionsSearchParams(value)).toBe(false);
    }
  });
});
