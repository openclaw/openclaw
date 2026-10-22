import fs from "node:fs";
import { expect, it } from "vitest";

it("declares its durable database for generic backup inventory", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  );
  expect(manifest.backupResources).toContainEqual({
    disposition: "include",
    scope: "state",
    relativePath: "plugins/workboard/workboard.sqlite",
  });
});
