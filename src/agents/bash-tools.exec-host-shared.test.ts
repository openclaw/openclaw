import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bash-tools.exec-approval-followup.js", () => ({
  sendExecApprovalFollowup: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

import { logWarn } from "../logger.js";
import { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";
import { sendExecApprovalFollowupResult } from "./bash-tools.exec-host-shared.js";

describe("sendExecApprovalFollowupResult", () => {
  beforeEach(() => {
    vi.mocked(sendExecApprovalFollowup).mockReset();
    vi.mocked(logWarn).mockReset();
  });

  it("logs repeated followup dispatch failures once per approval id and error message", async () => {
    vi.mocked(sendExecApprovalFollowup).mockRejectedValue(new Error("Channel is required"));

    const target = {
      approvalId: "approval-log-once",
      sessionKey: "agent:main:main",
    };
    await sendExecApprovalFollowupResult(target, "Exec finished");
    await sendExecApprovalFollowupResult(target, "Exec finished");

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "exec approval followup dispatch failed (id=approval-log-once): Channel is required",
    );
  });
});
