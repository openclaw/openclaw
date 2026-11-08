import { expect, it } from "vitest";
import { displayAliases } from "./knowledge-presentation.js";

it("display aliases hide account keys, merged titles and labelled variants of known names", () => {
  const aliases = [
    "Jacob",
    "jacobtomlinson",
    "discord:171650257380179968",
    "Jacob (Windows-node standup participant)",
    "Jacob (August 21 security standup participant)",
    "Jacob Tomlinson (Discord identity reference)",
  ];
  expect(
    displayAliases("Jacob Tomlinson", aliases, ["Jacob (August 21 security standup participant)"]),
  ).toStrictEqual(["Jacob", "jacobtomlinson"]);
});

it("a labelled alias with an unknown base name is kept", () => {
  expect(
    displayAliases("Gideon", ["Shakker", "Gideon (Control UI)", "Sam (guest)"], []),
  ).toStrictEqual(["Shakker", "Sam (guest)"]);
});
