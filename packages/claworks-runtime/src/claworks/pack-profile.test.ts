import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CW_EVENTS } from "../kernel/event-names.js";
import {
  applyPackProfile,
  parseProfilePackIds,
  PROFILE_PACK_ALIASES,
  resolvePackProfileIds,
} from "./pack-profile.js";
import * as packRuntime from "./pack-runtime.js";
import type { ClaworksRuntime } from "./runtime-types.js";

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

describe("applyPackProfile atomic switching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes concurrent profile switches", async () => {
    const order: string[] = [];
    const published: Array<{ type: string; profile: string }> = [];
    const runtime = {
      config: { packs: { installed: [] as string[] } },
      kernel: {
        publish: vi.fn(async (type: string, _source: string, payload: Record<string, unknown>) => {
          published.push({ type, profile: String(payload.profile) });
        }),
      },
      logger: vi.fn(),
    } as unknown as ClaworksRuntime;

    vi.spyOn(packRuntime, "persistInstalled").mockResolvedValue(undefined);
    vi.spyOn(packRuntime, "reloadClaworksPacks").mockImplementation(async (rt) => {
      const packs = rt.config.packs?.installed ?? [];
      const label = packs.includes("a") ? "enterprise" : "industrial";
      order.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end:${label}`);
    });

    const first = applyPackProfile(runtime, { profile: "enterprise", packIds: ["base", "a"] });
    const second = applyPackProfile(runtime, { profile: "industrial", packIds: ["base", "b"] });

    await Promise.all([first, second]);

    expect(order).toEqual([
      "start:enterprise",
      "end:enterprise",
      "start:industrial",
      "end:industrial",
    ]);
    expect(published).toEqual([
      { type: CW_EVENTS.PACK_PROFILE_LOADED, profile: "enterprise" },
      { type: CW_EVENTS.PACK_PROFILE_LOADED, profile: "industrial" },
    ]);
    expect(runtime.config.packs?.installed).toEqual(["base", "b"]);
  });
});
