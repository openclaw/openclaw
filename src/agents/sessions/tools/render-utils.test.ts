import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { reuseTextComponent, shortenPath, trimTrailingEmptyLines } from "./render-utils.js";

describe("trimTrailingEmptyLines", () => {
  it("removes all-empty input", () => {
    expect(trimTrailingEmptyLines(["", ""])).toEqual([]);
  });
});

describe("reuseTextComponent", () => {
  it("creates a zero-padding Text component when no prior component exists", () => {
    const component = reuseTextComponent(undefined, "hello");

    expect(component).toBeInstanceOf(Text);
    expect(component.render(5)).toEqual(["hello"]);
  });
});

describe("shortenPath", () => {
  const home = os.homedir();

  it("shortens paths inside the home directory", () => {
    expect(shortenPath(`${home}/projects/app.ts`)).toBe("~/projects/app.ts");
  });

  it.skipIf(process.platform !== "win32")("shortens real Windows home casing aliases", () => {
    const homeAlias = home.toUpperCase();
    expect(fs.statSync(homeAlias).isDirectory()).toBe(true);

    expect(shortenPath(path.join(homeAlias, "projects", "app.ts"))).toBe(
      `~${path.sep}projects${path.sep}app.ts`,
    );
  });

  it("returns an empty string for non-string input", () => {
    expect(shortenPath(undefined)).toBe("");
  });
});
