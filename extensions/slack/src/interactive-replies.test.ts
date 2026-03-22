import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";

describe("isSlackInteractiveRepliesEnabled", () => {
  it("fails closed when accountId is unknown and multiple accounts exist", () => {
    const cfg = {
      channels: {
        slack: {
          accounts: {
            one: {
              capabilities: { interactiveReplies: true },
            },
            two: {},
          },
        },
      },
    } as OpenClawConfig;

    expect(isSlackInteractiveRepliesEnabled({ cfg, accountId: undefined })).toBe(false);
  });

  it("uses the only configured account when accountId is unknown", () => {
    const cfg = {
      channels: {
        slack: {
          accounts: {
            only: {
              capabilities: { interactiveReplies: true },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(isSlackInteractiveRepliesEnabled({ cfg, accountId: undefined })).toBe(true);
  });
});
