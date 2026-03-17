import { describe, expect, it } from "vitest";
import { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";
describe("isSlackInteractiveRepliesEnabled", () => {
  it("fails closed when accountId is unknown and multiple accounts exist", () => {
    const cfg = {
      channels: {
        slack: {
          accounts: {
            one: {
              capabilities: { interactiveReplies: true }
            },
            two: {}
          }
        }
      }
    };
    expect(isSlackInteractiveRepliesEnabled({ cfg, accountId: void 0 })).toBe(false);
  });
  it("uses the only configured account when accountId is unknown", () => {
    const cfg = {
      channels: {
        slack: {
          accounts: {
            only: {
              capabilities: { interactiveReplies: true }
            }
          }
        }
      }
    };
    expect(isSlackInteractiveRepliesEnabled({ cfg, accountId: void 0 })).toBe(true);
  });
});
