import "../../test/dom.setup.ts";
import { expect, it } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { matchesCardQuery } from "./view-helpers.ts";

it("matches card ID prefixes case-insensitively", () => {
  const card = createWorkboardCard({ id: "123e4567-e89b-12d3-a456-426614174000" });
  const query = " 123E4567-E89B ";

  expect(matchesCardQuery(card, query)).toBe(true);
});
