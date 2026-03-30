import { beforeEach, describe, expect, it, vi } from "vitest";

let sendExecApprovalFollowupResult: typeof import("./bash-tools.exec-host-shared.js").sendExecApprovalFollowupResult;
let sendExecApprovalFollowup: typeof import("./bash-tools.exec-approval-followup.js").sendExecApprovalFollowup;
let logWarn: typeof import("../logger.js").logWarn;

describe("sendExecApprovalFollowupResult", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("./bash-tools.exec-approval-followup.js", () => ({
      sendExecApprovalFollowup: vi.fn(),
    }));
    vi.doMock("../logger.js", () => ({
      logWarn: vi.fn(),
    }));
    ({ sendExecApprovalFollowupResult } = await import("./bash-tools.exec-host-shared.js"));
    ({ sendExecApprovalFollowup } = await import("./bash-tools.exec-approval-followup.js"));
    ({ logWarn } = await import("../logger.js"));
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
