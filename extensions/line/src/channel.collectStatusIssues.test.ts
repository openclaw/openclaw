import { describe, expect, it } from "vitest";
import { linePlugin } from "./channel.js";

describe("LINE collectStatusIssues", () => {
  const collect = linePlugin.status!.collectStatusIssues!;

  it("returns no issues when account is configured", () => {
    const issues = collect([{ accountId: "default", configured: true, tokenSource: "config" }]);
    expect(issues).toEqual([]);
  });

  it("returns no issues when account is configured via file", () => {
    const issues = collect([{ accountId: "default", configured: true, tokenSource: "file" }]);
    expect(issues).toEqual([]);
  });

  it("returns issue when account is not configured", () => {
    const issues = collect([{ accountId: "default", configured: false, tokenSource: "none" }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      channel: "line",
      accountId: "default",
      kind: "config",
    });
  });

  it("returns issue when configured is undefined", () => {
    const issues = collect([{ accountId: "default" }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      channel: "line",
      accountId: "default",
      kind: "config",
    });
  });

  it("handles multiple accounts", () => {
    const issues = collect([
      { accountId: "default", configured: true, tokenSource: "file" },
      { accountId: "secondary", configured: false, tokenSource: "none" },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].accountId).toBe("secondary");
  });
});
