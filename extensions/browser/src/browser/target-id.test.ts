// Browser tests cover target id plugin behavior.
import { describe, expect, it } from "vitest";
import type { ProfileRuntimeState } from "./server-context.types.js";
import { assignTabAlias, resolveTargetIdFromTabs } from "./target-id.js";

describe("assignTabAlias", () => {
  it("rejects invalid labels without initializing alias state", () => {
    const profileState: ProfileRuntimeState = {
      profile: {} as ProfileRuntimeState["profile"],
      running: null,
    };

    expect(() =>
      assignTabAlias({
        profileState,
        tab: { targetId: "TARGET", title: "", url: "about:blank", type: "page" },
        label: "not allowed",
      }),
    ).toThrow(/tab label/i);
    expect(profileState.tabAliases).toBeUndefined();
  });
});

describe("resolveTargetIdFromTabs", () => {
  it("reports every match for an ambiguous raw target-id prefix", () => {
    expect(
      resolveTargetIdFromTabs("ABC", [{ targetId: "ABCDEF123456" }, { targetId: "ABC999" }]),
    ).toEqual({
      ok: false,
      reason: "ambiguous",
      matches: ["ABCDEF123456", "ABC999"],
    });
  });

  it.each(["suggestedTargetId", "tabId", "label"] as const)(
    "rejects a %s collision with another tab's raw target id",
    (field) => {
      const collidingTabs = [
        {
          targetId: "ABCDEF123456",
          [field]: "ABC999",
        },
        {
          targetId: "ABC999",
          suggestedTargetId: "t2",
          tabId: "t2",
        },
      ];
      expect(resolveTargetIdFromTabs("ABC999", collidingTabs)).toEqual({
        ok: false,
        reason: "ambiguous",
        matches: ["ABCDEF123456", "ABC999"],
      });
    },
  );

  it("rejects a raw-id and label collision regardless of tab order", () => {
    const collidingTabs = [
      {
        targetId: "ABC999",
        suggestedTargetId: "t2",
        tabId: "t2",
      },
      {
        targetId: "OTHER",
        label: "ABC999",
      },
    ];

    for (const orderedTabs of [collidingTabs, collidingTabs.toReversed()]) {
      const expectedMatches = orderedTabs.map((tab) => tab.targetId);
      expect(resolveTargetIdFromTabs("ABC999", orderedTabs)).toEqual({
        ok: false,
        reason: "ambiguous",
        matches: expectedMatches,
      });
    }
  });

  it("rejects friendly references shared by different tabs", () => {
    expect(
      resolveTargetIdFromTabs("shared", [
        { targetId: "FIRST", label: "shared" },
        { targetId: "SECOND", tabId: "shared" },
      ]),
    ).toEqual({
      ok: false,
      reason: "ambiguous",
      matches: ["FIRST", "SECOND"],
    });
  });

  it("deduplicates matching namespaces on the same tab", () => {
    expect(
      resolveTargetIdFromTabs("SAME", [
        {
          targetId: "SAME",
          suggestedTargetId: "SAME",
          tabId: "SAME",
          label: "SAME",
        },
      ]),
    ).toEqual({ ok: true, targetId: "SAME" });
  });
});
