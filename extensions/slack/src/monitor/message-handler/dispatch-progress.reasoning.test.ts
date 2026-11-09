import { WebClient } from "@slack/web-api";
import { resolveChannelInboundRouteEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackProgressRuntime } from "./dispatch-progress.js";
import { createSlackDispatchSetup } from "./dispatch-setup.js";
import { createSlackStreamingDeliveryRuntime } from "./dispatch-streaming.js";
import { createDraftStreamStub } from "./dispatch.compact-progress.test-support.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";

const draftStream = vi.hoisted(() => ({ current: undefined as unknown }));
let reasoningMergeCount = 0;

vi.mock("../../draft-stream.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../draft-stream.js")>()),
  createSlackDraftStream: () => draftStream.current,
}));
vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    createChannelProgressDraftCompositor: (
      params: Parameters<typeof actual.createChannelProgressDraftCompositor>[0],
    ) => {
      const compositor = actual.createChannelProgressDraftCompositor({
        ...params,
        // Start the draft at once; gate timing lives in the compositor suite.
        setTimeoutFn: ((handler: () => void) => {
          handler();
          return 0 as never;
        }) as unknown as typeof setTimeout,
        clearTimeoutFn: (() => {}) as typeof clearTimeout,
      });
      // Each merge reprocesses the accumulated reasoning text, so count them.
      const merge = compositor.mergeReasoningProgress;
      compositor.mergeReasoningProgress = (...args) => {
        reasoningMergeCount += 1;
        return merge(...args);
      };
      return compositor;
    },
  };
});

async function createProgress(streaming: SlackAccountConfig["streaming"]) {
  const ctx = createInboundSlackTestContext({
    cfg: {},
    appClient: new WebClient(),
    replyToMode: "all",
  });
  const { route } = resolveChannelInboundRouteEnvelope({
    cfg: {},
    channel: "slack",
    accountId: "default",
    peer: { kind: "direct", id: "U1" },
  });
  const setup = await createSlackDispatchSetup({
    ctx,
    account: createSlackTestAccount({ streaming }),
    message: { type: "message", channel: "D1", ts: "1.000" },
    route,
    channelConfig: null,
    replyTarget: "user:U1",
    ctxPayload: { Body: "hello", CommandAuthorized: false, ChatType: "direct" },
    turn: { record: {} },
    replyToMode: "all",
    isDirectMessage: true,
    isRoomish: false,
    ackReactionValue: "",
    ackReactionPromise: null,
  });
  return createSlackProgressRuntime({
    setup,
    delivery: createSlackStreamingDeliveryRuntime(setup),
  });
}

const REASONING_DELTAS = ["Checking the first path", " and the second path", " before answering"];

beforeEach(() => {
  reasoningMergeCount = 0;
  draftStream.current = createDraftStreamStub();
});

describe("Slack reasoning progress", () => {
  it("does no reasoning work when streaming is off and no preview can show it", async () => {
    const progress = await createProgress({ mode: "off" });

    for (const text of REASONING_DELTAS) {
      expect(await progress.pushReasoningProgress({ text })).toBe(false);
    }

    expect(progress.progressDraftActive).toBe(false);
    expect(reasoningMergeCount).toBe(0);
  });

  it("still streams merged reasoning into a partial preview", async () => {
    const stub = createDraftStreamStub();
    draftStream.current = stub;
    const progress = await createProgress({ mode: "partial", nativeTransport: false });

    for (const text of REASONING_DELTAS) {
      await progress.pushReasoningProgress({ text });
    }

    expect(reasoningMergeCount).toBeGreaterThan(0);
    const updates = stub.update.mock.calls.map(([update]) =>
      typeof update === "string" ? update : String((update as { text?: unknown }).text),
    );
    expect(updates.at(-1)).toContain(
      "Checking the first path and the second path before answering",
    );
  });
});
