// Zalo tests cover status issues plugin behavior.
import assert from "node:assert/strict";
import { expectOpenDmPolicyConfigIssue } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, it } from "vitest";
import { zaloPlugin } from "./channel.js";

describe("collectZaloStatusIssues", () => {
  it("warns when dmPolicy is open", () => {
    const collectIssues = zaloPlugin.status?.collectStatusIssues;
    assert(collectIssues);
    expectOpenDmPolicyConfigIssue({
      collectIssues,
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        dmPolicy: "open",
      },
    });
  });
});
