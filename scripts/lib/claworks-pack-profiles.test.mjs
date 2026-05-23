import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvePackProfile } from "./claworks-pack-profiles.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packsDir = join(here, "..", "..", "..", "claworks-packs");

describe("claworks-pack-profiles", () => {
  it("resolves enterprise profile from claworks.packs.json", () => {
    const packs = resolvePackProfile(packsDir, "enterprise");
    expect(packs[0]).toBe("base");
    expect(packs).toContain("enterprise-general");
    expect(packs).not.toContain("core");
  });

  it("maps legacy minimal profile to new base chain", () => {
    const packs = resolvePackProfile(packsDir, "minimal");
    expect(packs[0]).toBe("base");
    expect(packs).not.toContain("core");
  });

  it("maps legacy industrial-robot to industrial-new", () => {
    const packs = resolvePackProfile(packsDir, "industrial-robot");
    expect(packs).toContain("process-industry");
    expect(packs).not.toContain("industrial");
  });
});
