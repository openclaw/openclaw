import { describe, expect, it } from "vitest";
import { crawlRefreshAction } from "./crawl-refresh-action.js";

describe("crawlRefreshAction.validate", () => {
  it("accepts real http links and keeps the original shape", () => {
    const r = crawlRefreshAction.validate({ links: ["https://a.com/1"], name: "广本3条" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.links).toEqual(["https://a.com/1"]);
      expect(r.params.name).toBe("广本3条");
    }
  });

  it("rejects the literal '[]' string (the original silent-pass bug)", () => {
    expect(crawlRefreshAction.validate({ links: "[]" }).ok).toBe(false);
  });

  it("rejects empty links and non-url strings", () => {
    expect(crawlRefreshAction.validate({ links: [] }).ok).toBe(false);
    expect(crawlRefreshAction.validate({ links: "not-a-url" }).ok).toBe(false);
    expect(crawlRefreshAction.validate({}).ok).toBe(false);
  });

  it("accepts feeds with a valid feedId", () => {
    const r = crawlRefreshAction.validate({ feeds: [{ feedId: 12, url: "https://a.com/x" }], topicId: 3 });
    expect(r.ok).toBe(true);
  });
});
