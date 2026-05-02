import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, test } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackRoutingContextDeps } from "./prepare-routing.js";
import { resolveSlackRoutingContext } from "./prepare-routing.js";

const buildDeps = (mode: "all" | "off" | "first" | "batched"): SlackRoutingContextDeps => ({
  cfg: {
    session: {},
    channels: { slack: { enabled: true, replyToMode: mode } },
  } as OpenClawConfig,
  teamId: "T1",
  threadInheritParent: false,
  threadHistoryScope: "thread",
});

const buildAccount = (mode: "all" | "off" | "first" | "batched"): ResolvedSlackAccount => ({
  accountId: "default",
  enabled: true,
  botTokenSource: "config",
  appTokenSource: "config",
  userTokenSource: "none",
  config: { replyToMode: mode },
  replyToMode: mode,
});

const buildMessage = (params: {
  ts: string;
  thread_ts?: string;
  channel?: string;
  text?: string;
}): SlackMessageEvent => ({
  type: "message",
  ts: params.ts,
  thread_ts: params.thread_ts,
  channel: params.channel || "C1",
  channel_type: "channel",
  user: "U1",
  text: params.text || "test message",
});

describe("Slack Routing Matrix (Race Condition Proof)", () => {
  test.each`
    desc                   | mode         | isRoom   | isGroupDm | isDm     | expectedDistinct
    ${"DM - all"}          | ${"all"}     | ${false} | ${false}  | ${true}  | ${false}
    ${"DM - first"}        | ${"first"}   | ${false} | ${false}  | ${true}  | ${false}
    ${"DM - off"}          | ${"off"}     | ${false} | ${false}  | ${true}  | ${false}
    ${"DM - batched"}      | ${"batched"} | ${false} | ${false}  | ${true}  | ${false}
    ${"GroupDM - all"}     | ${"all"}     | ${false} | ${true}   | ${false} | ${false}
    ${"GroupDM - first"}   | ${"first"}   | ${false} | ${true}   | ${false} | ${false}
    ${"GroupDM - off"}     | ${"off"}     | ${false} | ${true}   | ${false} | ${false}
    ${"GroupDM - batched"} | ${"batched"} | ${false} | ${true}   | ${false} | ${false}
    ${"Room - all"}        | ${"all"}     | ${true}  | ${false}  | ${false} | ${true}
    ${"Room - first"}      | ${"first"}   | ${true}  | ${false}  | ${false} | ${false}
    ${"Room - off"}        | ${"off"}     | ${true}  | ${false}  | ${false} | ${false}
    ${"Room - batched"}    | ${"batched"} | ${true}  | ${false}  | ${false} | ${false}
    ${"Fallback - all"}    | ${"all"}     | ${false} | ${false}  | ${false} | ${true}
    ${"Fallback - off"}    | ${"off"}     | ${false} | ${false}  | ${false} | ${false}
  `("$desc ($mode)", ({ mode, isRoom, isGroupDm, isDm, expectedDistinct }) => {
    const ctx = buildDeps(mode);
    const account = buildAccount(mode);

    const ts1 = "1770408518.451689";
    const ts2 = "1770408520.000001";

    const isRoomish = isRoom || isGroupDm;

    const runRouting = (ts: string) =>
      resolveSlackRoutingContext({
        ctx,
        account,
        message: buildMessage({ ts }),
        isRoom,
        isRoomish,
        isGroupDm,
        isDirectMessage: isDm,
      });

    const r1 = runRouting(ts1);
    const r2 = runRouting(ts2);

    if (expectedDistinct) {
      expect(r1.sessionKey).not.toBe(r2.sessionKey);
      expect(r1.sessionKey).toContain(`:thread:${ts1}`);
      expect(r2.sessionKey).toContain(`:thread:${ts2}`);
    } else {
      expect(r1.sessionKey).toBe(r2.sessionKey);
    }
  });

  test("should correctly seed thread context for top-level messages", () => {
    const ctx = buildDeps("all");
    const account = buildAccount("all");
    const ts = "12345.678";

    const routing = resolveSlackRoutingContext({
      ctx,
      account,
      message: buildMessage({ ts }),
      isRoomish: true,
      isRoom: true,
      isGroupDm: false,
      isDirectMessage: false,
      seedTopLevelRoomThread: true,
    });

    expect(routing.threadContext.messageTs).toBe(ts);
    expect(routing.sessionKey).toContain(`:thread:${ts}`);
  });

  test("reply should inherit session from its parent thread", () => {
    const ctx = buildDeps("all");
    const account = buildAccount("all");
    const rootTs = "1000.001";
    const replyTs = "1000.005";

    const params = {
      ctx,
      account,
      isRoomish: true,
      isRoom: true,
      isGroupDm: false,
      isDirectMessage: false,
    };

    const root = resolveSlackRoutingContext({
      ...params,
      message: buildMessage({ ts: rootTs }),
    });
    const reply = resolveSlackRoutingContext({
      ...params,
      message: buildMessage({ ts: replyTs, thread_ts: rootTs }),
    });

    expect(reply.sessionKey).toBe(root.sessionKey);
  });
});
