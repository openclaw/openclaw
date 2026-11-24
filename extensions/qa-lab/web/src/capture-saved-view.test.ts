import { describe, expect, it } from "vitest";
import { normalizeCaptureSavedView, normalizeCaptureSavedViews } from "./capture-saved-view.js";

describe("capture saved views", () => {
  it("drops non-object and nameless saved views", () => {
    expect(normalizeCaptureSavedView(null)).toBeNull();
    expect(normalizeCaptureSavedView({ id: "view-1" })).toBeNull();
    expect(normalizeCaptureSavedViews([{ id: "view-1" }, "bad", null])).toEqual([]);
  });

  it("keeps valid saved view fields", () => {
    const view = {
      id: "view-1",
      name: "Errors",
      sessionIds: ["session-a"],
      kindFilter: ["request"],
      providerFilter: ["openai"],
      hostFilter: ["api.example.test"],
      searchText: "timeout",
      headerMode: "all",
      viewMode: "timeline",
      groupMode: "flow",
      timelineLaneMode: "provider",
      timelineLaneSort: "severity",
      timelineZoom: 200,
      timelineSparklineMode: "lane-relative",
      errorsOnly: true,
      detailPlacement: "bottom",
      payloadLayout: "raw",
      payloadExtent: "full",
    };
    expect(normalizeCaptureSavedView(view)).toEqual(view);
  });

  it("falls back invalid enum and scalar fields to safe defaults", () => {
    const fields: [string, unknown, unknown][] = [
      ["sessionIds", ["session-a", 42, "  "], ["session-a"]],
      ["kindFilter", "request", []],
      ["providerFilter", ["openai"], ["openai"]],
      ["hostFilter", null, []],
      ["searchText", 123, ""],
      ["headerMode", "everything", "key"],
      ["viewMode", "grid", "list"],
      ["groupMode", "cards", "none"],
      ["timelineLaneMode", "host", "domain"],
      ["timelineLaneSort", "random", "most-events"],
      ["timelineZoom", 999, 100],
      ["timelineSparklineMode", "global", "session-relative"],
      ["errorsOnly", "yes", false],
      ["detailPlacement", "left", "right"],
      ["payloadLayout", "html", null],
      ["payloadExtent", "all", "preview"],
    ];
    expect(
      normalizeCaptureSavedView({
        id: "view-1",
        name: "Corrupt",
        ...Object.fromEntries(fields.map(([key, input]) => [key, input])),
      }),
    ).toMatchObject(Object.fromEntries(fields.map(([key, , expected]) => [key, expected])));
  });

  it("caps loaded saved views to the UI limit", () => {
    const views = Array.from({ length: 20 }, (_, index) => ({
      id: `view-${index}`,
      name: `View ${index}`,
    }));

    expect(normalizeCaptureSavedViews(views)).toHaveLength(12);
  });

  it("keeps bounded saved view text on UTF-16 boundaries", () => {
    const view = normalizeCaptureSavedView({
      id: `${"i".repeat(255)}😀after`,
      name: `${"n".repeat(79)}😀after`,
      sessionIds: [`${"s".repeat(255)}😀after`],
      searchText: `${"q".repeat(499)}😀after`,
    });

    expect(view).toMatchObject({
      id: "i".repeat(255),
      name: "n".repeat(79),
      sessionIds: ["s".repeat(255)],
      searchText: "q".repeat(499),
    });
  });
});
