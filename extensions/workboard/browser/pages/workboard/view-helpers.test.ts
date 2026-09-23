import "../../test/dom.setup.ts";
import { expect, it } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { matchesFilter } from "./view-helpers.ts";

it("matches card ID prefixes without bypassing the priority filter", () => {
  const card = createWorkboardCard({ id: "123e4567-e89b-12d3-a456-426614174000" });
  const query = " 123E4567-E89B ";

  expect(matchesFilter(card, { query, priority: "all" })).toBe(true);
  expect(matchesFilter(card, { query, priority: "high" })).toBe(false);
});
