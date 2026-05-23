import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInstalledPackIds } from "./loader.js";

describe("resolveInstalledPackIds", () => {
  const packsDir = join(process.cwd(), "../claworks-packs");

  it("auto-includes enterprise-foundation when enterprise-general is installed", async () => {
    const ids = await resolveInstalledPackIds(["enterprise-general"], [packsDir]);
    expect(ids).toContain("enterprise-foundation");
    expect(ids.indexOf("enterprise-foundation")).toBeLessThan(ids.indexOf("enterprise-general"));
  });

  it("loads base before enterprise-foundation", async () => {
    const ids = await resolveInstalledPackIds(["enterprise-general"], [packsDir]);
    expect(ids).toContain("base");
    expect(ids.indexOf("base")).toBeLessThan(ids.indexOf("enterprise-foundation"));
  });
});
