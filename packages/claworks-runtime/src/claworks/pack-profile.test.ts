import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseProfilePackIds,
  PROFILE_PACK_ALIASES,
  resolvePackProfileIds,
} from "./pack-profile.js";

describe("resolvePackProfileIds", () => {
  it("maps init profile aliases to claworks.packs.json keys", () => {
    expect(PROFILE_PACK_ALIASES.industrial).toBe("industrial-new");
    expect(PROFILE_PACK_ALIASES.enterprise).toBe("enterprise");
    expect(PROFILE_PACK_ALIASES["daily-report"]).toBe("daily-report");
  });

  it("reads enabled_packs from claworks.packs.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-packs-"));
    writeFileSync(
      join(dir, "claworks.packs.json"),
      JSON.stringify({
        default_profile: "enterprise-base-new",
        profiles: {
          "industrial-new": {
            enabled_packs: [
              "base",
              "enterprise-foundation",
              "domain-operations",
              "process-industry",
            ],
          },
          enterprise: {
            enabled_packs: [
              "base",
              "enterprise-foundation",
              "process-industry",
              "enterprise-general",
            ],
          },
        },
      }),
      "utf8",
    );

    expect(resolvePackProfileIds("industrial", { packsDir: dir })).toEqual([
      "base",
      "enterprise-foundation",
      "domain-operations",
      "process-industry",
    ]);
    expect(resolvePackProfileIds("enterprise", { packsDir: dir })).toEqual([
      "base",
      "enterprise-foundation",
      "process-industry",
      "enterprise-general",
    ]);
  });

  it("prefers explicit pack ids over profile lookup", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-packs-explicit-"));
    mkdirSync(join(dir, "base"), { recursive: true });
    writeFileSync(
      join(dir, "claworks.packs.json"),
      JSON.stringify({
        profiles: {
          enterprise: { enabled_packs: ["base", "enterprise-foundation"] },
        },
      }),
      "utf8",
    );

    expect(
      resolvePackProfileIds("enterprise", {
        packsDir: dir,
        explicitPackIds: ["base", "daily-report"],
      }),
    ).toEqual(["base", "daily-report"]);
  });
});

describe("parseProfilePackIds", () => {
  it("accepts array, json string, and comma-separated packs", () => {
    expect(parseProfilePackIds({ packs: ["base", "daily-report"] })).toEqual([
      "base",
      "daily-report",
    ]);
    expect(parseProfilePackIds({ packs: '["base","enterprise-general"]' })).toEqual([
      "base",
      "enterprise-general",
    ]);
    expect(parseProfilePackIds({ packs: "base, enterprise-general" })).toEqual([
      "base",
      "enterprise-general",
    ]);
  });
});
