import { describe, expect, it } from "vitest";
import { normalizeFeishuEvent } from "./event.model.js";
import {
  renderFeishuEventTriggerCommand,
  resolveFeishuEventTriggerPlan,
  resolveFeishuEventTriggerSessionKeyHint,
} from "./event.trigger.js";

function createCalendarEvent() {
  return normalizeFeishuEvent({
    accountId: "default",
    eventType: "calendar.calendar.event.changed_v4",
    payload: {
      event_id: "evt_calendar_1",
      calendar_id: "cal_123",
      operator_id: {
        open_id: "ou_operator",
      },
    },
  });
}

describe("event.trigger", () => {
  it("renders a command-style prompt from normalized events", () => {
    const command = renderFeishuEventTriggerCommand({
      event: createCalendarEvent(),
      trigger: {
        command: "/run-event",
        instructions: "summarize and notify",
      },
    });

    expect(command).toContain("/run-event calendar.calendar.event.changed_v4");
    expect(command).toContain("category=calendar.event");
    expect(command).toContain("instructions=summarize and notify");
    expect(command).toContain("open_id=ou_operator");
  });

  it("builds isolated session hints by default", () => {
    const sessionKeyHint = resolveFeishuEventTriggerSessionKeyHint({
      event: createCalendarEvent(),
      agentId: "ops",
    });

    expect(sessionKeyHint).toBe(
      "agent:ops:cron:feishu-event:default:calendar.event:evt_calendar_1",
    );
  });

  it("supports custom session hints for custom mode triggers", () => {
    const plan = resolveFeishuEventTriggerPlan({
      event: createCalendarEvent(),
      trigger: {
        mode: "custom",
        agentId: "planner",
        customSessionId: "calendar-digest",
      },
    });

    expect(plan.mode).toBe("custom");
    expect(plan.agentId).toBe("planner");
    expect(plan.sessionKeyHint).toBe("agent:planner:feishu:event:calendar-digest");
    expect(plan.summary).toContain("calendar.calendar.event.changed_v4");
  });
});
