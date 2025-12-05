import { describe, expect, it } from "vitest";

import { piSpec } from "./pi.js";

describe("piSpec.isInvocation", () => {
  it("detects pi binary", () => {
    expect(piSpec.isInvocation(["/usr/local/bin/pi"])).toBe(true);
  });

  it("detects tau binary", () => {
    expect(piSpec.isInvocation(["/opt/tau"])).toBe(true);
  });

  it("detects node entry pointing at coding-agent cli", () => {
    expect(
      piSpec.isInvocation([
        "node",
        "/Users/me/Projects/pi-mono/packages/coding-agent/dist/cli.js",
      ]),
    ).toBe(true);
  });

  it("rejects unrelated node scripts", () => {
    expect(piSpec.isInvocation(["node", "/tmp/script.js"])).toBe(false);
  });
});
