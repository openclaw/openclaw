import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TYPES_PATH = fileURLToPath(new URL("./types.ts", import.meta.url));

describe("AgentRuntimePlan leaf contracts", () => {
  it("keeps runtime plan type contracts independent from concrete runtime policy modules", async () => {
    const source = await fs.readFile(TYPES_PATH, "utf8");

    expect(source).not.toMatch(/from "\.\.\/\.\.\/auto-reply\//);
    expect(source).not.toMatch(/from "\.\.\/\.\.\/config\//);
    expect(source).not.toMatch(/from "\.\.\/\.\.\/plugins\//);
    expect(source).not.toMatch(/from "\.\.\/pi-embedded-/);
    expect(source).not.toMatch(/from "\.\.\/transcript-policy/);
    expect(source).not.toMatch(/from "\.\.\/system-prompt/);
  });
});
