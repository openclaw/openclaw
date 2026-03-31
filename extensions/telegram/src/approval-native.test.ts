import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { telegramNativeApprovalAdapter } from "./approval-native.js";

function buildConfig(
  overrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>>,
): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: "tok",
        execApprovals: {
          enabled: true,
          approvers: ["8460800771"],
          target: "dm",
        },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

describe("telegram native approval adapter", () => {
  it("normalizes direct-chat origin targets so DM dedupe can converge", async () => {
    const target = await telegramNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "telegram",
          turnSourceTo: "telegram:8460800771",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:telegram:direct:8460800771",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "8460800771",
      threadId: undefined,
    });
  });
});
