import { expect, it } from "vitest";
import { locationParams, readLocation } from "./page-location.js";

it("restores Browse continuation and previous pages beyond offset 500", () => {
  const params = { view: "browse", offset: "600", back: "0,500,550", filter: "Fictional" };
  const location = readLocation(params);
  expect(location).toMatchObject({ offset: 600, back: [0, 500, 550], filter: "Fictional" });
  expect(locationParams(location)).toEqual(params);
  expect(readLocation(locationParams(location))).toEqual(location);
});

it("keeps invalid offsets, invalid back trails, and bounded Search out of URL state", () => {
  for (const offset of ["-1", "1.5", "Infinity", "9007199254740992", "1e3"]) {
    expect(readLocation({ view: "browse", offset }).offset).toBe(0);
  }
  expect(readLocation({ view: "browse", offset: "9007199254740991" }).offset).toBe(
    Number.MAX_SAFE_INTEGER,
  );
  for (const back of ["0,-1", "0,500,500", "0,600", "550,500", "0,9007199254740992"]) {
    expect(readLocation({ view: "browse", offset: "600", back }).back).toEqual([]);
  }
  expect(readLocation({ view: "search", offset: "500" }).offset).toBe(500);
  expect(readLocation({ view: "search", offset: "501" }).offset).toBe(0);
});
