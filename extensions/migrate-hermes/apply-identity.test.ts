// Migrate Hermes tests cover apply result identity.
import type { MigrationPlan } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { applyHermesPlan } from "./apply.js";
import { useHermesFixture } from "./test/migration-fixture.js";

describe("Hermes migration apply identity", () => {
  const fixture = useHermesFixture();

  it("keeps results separate when report item ids repeat", async () => {
    const { source } = fixture.paths;
    const plan: MigrationPlan = {
      providerId: "hermes",
      source,
      items: [
        {
          id: "manual:repeated",
          kind: "manual",
          action: "manual",
          status: "planned",
          reason: "first follow-up",
        },
        {
          id: "manual:repeated",
          kind: "manual",
          action: "manual",
          status: "planned",
          reason: "second follow-up",
        },
      ],
      summary: {
        total: 2,
        planned: 2,
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
    };

    const result = await applyHermesPlan({
      ctx: fixture.context(),
      plan,
    });

    expect(result.items.map((item) => item.reason)).toEqual([
      "first follow-up",
      "second follow-up",
    ]);
    expect(result.items.every((item) => item.status === "skipped")).toBe(true);
  });
});
