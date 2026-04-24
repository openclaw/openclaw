import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TYPES_PATH = fileURLToPath(new URL("./types.ts", import.meta.url));

describe("AgentRuntimePlan leaf contracts", () => {
  it("keeps runtime plan type contracts independent from concrete runtime policy modules", async () => {
    const source = await fs.readFile(TYPES_PATH, "utf8");

    expect(source).not.toMatch(/from\s+["'][^"']*auto-reply(?:\/|\.js|["'])/);
    expect(source).not.toMatch(/from\s+["'][^"']*config(?:\/|\.js|["'])/);
    expect(source).not.toMatch(/from\s+["'][^"']*plugins(?:\/|\.js|["'])/);
    expect(source).not.toMatch(/from\s+["'][^"']*pi-embedded-/);
    expect(source).not.toMatch(/from\s+["'][^"']*transcript-policy(?:\/|\.js|["'])/);
    expect(source).not.toMatch(/from\s+["'][^"']*system-prompt(?:\/|\.js|["'])/);
  });
});
