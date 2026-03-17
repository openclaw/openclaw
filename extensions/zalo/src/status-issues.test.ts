import { describe, expect, it } from "vitest";
import { expectOpenDmPolicyConfigIssue } from "../../../test/helpers/extensions/status-issues.js";
import { collectZaloStatusIssues } from "./status-issues.js";

describe("collectZaloStatusIssues", () => {
  it("warns when dmPolicy is open", () => {
    expectOpenDmPolicyConfigIssue({
      collectIssues: collectZaloStatusIssues,
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        dmPolicy: "open",
      },
    });
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
