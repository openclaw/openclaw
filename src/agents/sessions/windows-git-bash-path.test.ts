import { describe, expect, it } from "vitest";
import { resolveConfigValueUncached } from "./resolve-config-value.js";

const isWindows = process.platform === "win32";

describe.runIf(isWindows)("Git Bash PATH integration", () => {
  it("exposes Git coreutils to !command config resolution", async () => {
    expect(await resolveConfigValueUncached("!command -v cygpath")).toMatch(/usr\/bin\/cygpath/i);
  });
});
