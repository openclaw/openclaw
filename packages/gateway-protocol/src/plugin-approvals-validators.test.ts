import { describe, expect, it } from "vitest";
import { validatePluginApprovalRequestParams } from "./index.js";

describe("plugin approval protocol validators", () => {
  it("accepts enriched approval descriptions up to 512 characters", () => {
    const request = {
      title: "Apply workspace skill proposal",
      description: "d".repeat(512),
    };

    expect(validatePluginApprovalRequestParams(request)).toBe(true);
    expect(validatePluginApprovalRequestParams({ ...request, description: "d".repeat(513) })).toBe(
      false,
    );
  });
});
