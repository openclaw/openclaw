import { describe, expect, it } from "vitest";
import { collectZaloStatusIssues } from "./status-issues.js";

describe("collectZaloStatusIssues", () => {
  it("warns when dmPolicy is open", () => {
    const issues = collectZaloStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        dmPolicy: "open",
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("config");
  });

  it("skips unconfigured accounts", () => {
    const issues = collectZaloStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: false,
        dmPolicy: "open",
      },
    ]);
    expect(issues).toHaveLength(0);
  });
});
