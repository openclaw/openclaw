import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
  RoutinesCreateParamsSchema,
  RoutinesCreateResultSchema,
  validateRoutinesCreateParams,
} from "./index.js";

function createRoutineParams() {
  return {
    id: "weekday-standup",
    name: "Weekday standup",
    owner: { agentId: "ops" },
    target: {
      sessionTarget: "isolated",
      wakeMode: "now",
      delivery: { mode: "announce", channel: "last" },
    },
    trigger: {
      kind: "schedule",
      schedule: { kind: "cron", expr: "0 9 * * 1-5" },
    },
    action: {
      kind: "agentTurn",
      message: "Review overnight updates.",
    },
  };
}

describe("routines protocol schemas", () => {
  it("accepts schedule-backed create params and rejects future trigger kinds", () => {
    expect(validateRoutinesCreateParams(createRoutineParams())).toBe(true);

    expect(
      validateRoutinesCreateParams({
        ...createRoutineParams(),
        trigger: { kind: "webhook", id: "later" },
      }),
    ).toBe(false);
  });

  it("validates routine view results with status", () => {
    const validate = Compile(RoutinesCreateResultSchema);
    const routine = {
      ...createRoutineParams(),
      enabled: true,
      description: "Weekday operations loop",
      trigger: {
        kind: "schedule",
        schedule: { kind: "cron", expr: "0 9 * * 1-5" },
        cronJobId: "cron-1",
        cronStoreKey: "/tmp/openclaw/state.sqlite",
      },
      action: {
        kind: "agentTurn",
        message: "Review overnight updates.",
      },
      createdAtMs: 1,
      updatedAtMs: 2,
      status: {
        status: "enabled",
        backing: "linked",
        enabled: true,
        cronJobId: "cron-1",
        nextRunAtMs: 3,
      },
    };

    expect(validate.Check({ routine, created: true, idempotent: false })).toBe(true);
  });

  it("keeps create params registered in the protocol schema registry", () => {
    expect(RoutinesCreateParamsSchema).toBeDefined();
  });
});
