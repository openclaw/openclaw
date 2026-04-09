import { describe, expect, it } from "vitest";
import { __testing } from "./latest-digest-cache.js";

describe("extractDigestSummary", () => {
  it("reads digest summary from result payloads", () => {
    const payload = {
      result: {
        notification_digest_summary: [{ digest_title: "Digest summary" }],
      },
    };
    expect(__testing.extractDigestSummary(payload)).toEqual([{ digest_title: "Digest summary" }]);
  });

  it("returns undefined when no digest summary exists", () => {
    expect(__testing.extractDigestSummary({ result: {} })).toBeUndefined();
  });
});
