import { describe, expect, it } from "vitest";
import { resolveFeishuGroupConfig } from "./policy.js";
import type { FeishuConfig } from "./types.js";

describe("resolveFeishuGroupConfig", () => {
  it("falls back to wildcard group config when direct match is missing", () => {
    const cfg = {
      groups: {
        "*": { requireMention: false },
        "oc-explicit": { requireMention: true },
      },
    } as FeishuConfig;

    const resolved = resolveFeishuGroupConfig({
      cfg,
      groupId: "oc-missing",
    });

    expect(resolved).toEqual({ requireMention: false });
  });

  it("prefers exact group config over wildcard", () => {
    const cfg = {
      groups: {
        "*": { requireMention: false },
        "oc-explicit": { requireMention: true },
      },
    } as FeishuConfig;

    const resolved = resolveFeishuGroupConfig({
      cfg,
      groupId: "oc-explicit",
    });

    expect(resolved).toEqual({ requireMention: true });
  });

  it("keeps case-insensitive matching for explicit group ids", () => {
    const cfg = {
      groups: {
        "*": { requireMention: false },
        OC_UPPER: { requireMention: true },
      },
    } as FeishuConfig;

    const resolved = resolveFeishuGroupConfig({
      cfg,
      groupId: "oc_upper",
    });

    expect(resolved).toEqual({ requireMention: true });
  });
});
