import { describe, expect, it, vi } from "vitest";
import { createRemindTool } from "./remind.js";

describe("bridge/tools/remind", () => {
  it("marks qqbot_remind as owner-only", () => {
    const tool = createRemindTool();
    expect(tool.ownerOnly).toBe(true);
  });

  it("schedules reminders directly through cron with ambient QQ delivery context", async () => {
    const callCron = vi.fn(async () => ({ id: "job-1" }));
    const tool = createRemindTool(
      {
        senderIsOwner: true,
        deliveryContext: { to: "qqbot:c2c:user-openid", accountId: "bot2" },
      },
      { callCron },
    );

    const result = await tool.execute("tool-call-1", {
      action: "add",
      content: "drink water",
      time: "5m",
    });

    expect(callCron).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "add",
        job: expect.objectContaining({
          delivery: {
            mode: "announce",
            channel: "qqbot",
            to: "qqbot:c2c:user-openid",
            accountId: "bot2",
          },
        }),
      }),
    );
    expect(result.details).toMatchObject({
      ok: true,
      action: "add",
      cronResult: { id: "job-1" },
    });
  });

  it("does not schedule when sender ownership is missing", async () => {
    const callCron = vi.fn(async () => ({ id: "job-1" }));
    const tool = createRemindTool(
      {
        deliveryContext: { to: "qqbot:c2c:user-openid", accountId: "bot2" },
      },
      { callCron },
    );

    const result = await tool.execute("tool-call-1", {
      action: "add",
      content: "drink water",
      time: "5m",
    });

    expect(callCron).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      error: "QQ reminders require an owner-authorized sender.",
    });
  });
});
