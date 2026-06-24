// Terminal Core tests cover display string path shortening.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { displayString } from "./display-string.js";

describe("displayString", () => {
  const originalOpenClawHome = process.env.OPENCLAW_HOME;

  afterEach(() => {
    if (originalOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalOpenClawHome;
    }
  });

  it("shortens the effective home path only at path boundaries", () => {
    const home = path.resolve("tmp", "openclaw-home", "al");
    process.env.OPENCLAW_HOME = home;

    expect(displayString(path.join(home, "project"))).toBe(path.join("$OPENCLAW_HOME", "project"));
    expect(displayString(`path=${path.join(home, "project")}`)).toBe(
      `path=${path.join("$OPENCLAW_HOME", "project")}`,
    );
    expect(displayString(`${home}ice${path.sep}project`)).toBe(`${home}ice${path.sep}project`);
  });
});
