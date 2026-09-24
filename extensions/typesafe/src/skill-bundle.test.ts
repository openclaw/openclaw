import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseInput } from "./schema.js";

it("provides a valid mixed judgment example with the declared skill", () => {
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("openclaw.plugin.json", root), "utf8"));
  expect(manifest.skills).toEqual(["./skills/typesafe-evaluate"]);
  const skill = readFileSync(new URL("skills/typesafe-evaluate/SKILL.md", root), "utf8");
  expect(skill).toContain("typesafe_evaluate");
  const request = JSON.parse(
    readFileSync(new URL("skills/typesafe-evaluate/references/request-example.json", root), "utf8"),
  );
  expect(() => parseInput(request)).not.toThrow();
});
