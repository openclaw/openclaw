import { WebClient } from "@slack/web-api";
import { resolveChannelInboundRouteEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackProgressRuntime } from "./dispatch-progress.js";
import { createSlackDispatchSetup } from "./dispatch-setup.js";
import { createSlackStreamingDeliveryRuntime } from "./dispatch-streaming.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";

vi.mock("../../draft-stream.js", async (importOriginal) => {
  const { createDraftStreamStub } = await import("./dispatch.compact-progress.test-support.js");
  return {
    ...(await importOriginal<typeof import("../../draft-stream.js")>()),
    createSlackDraftStream: vi.fn(createDraftStreamStub),
  };
});
afterEach(() => vi.restoreAllMocks());

async function fixture(mode: "off" | "partial") {
  const client = new WebClient();
  const api = vi.spyOn(client, "apiCall").mockResolvedValue({ ok: true });
  const ctx = createInboundSlackTestContext({ cfg: {}, appClient: client, replyToMode: "all" });
  const { route } = resolveChannelInboundRouteEnvelope({
    cfg: {},
    channel: "slack",
    accountId: "default",
    peer: { kind: "group", id: "C1" },
  });
  const setup = await createSlackDispatchSetup({
    ctx,
    account: createSlackTestAccount({ streaming: { mode, nativeTransport: false } }),
    message: { type: "message", channel: "C1", ts: "1.000", thread_ts: "1.000" },
    route,
    channelConfig: null,
    replyTarget: "channel:C1",
    ctxPayload: { Body: "hello", CommandAuthorized: false, ChatType: "group" },
    turn: { record: {} },
    replyToMode: "all",
    isDirectMessage: false,
    isRoomish: true,
    ackReactionValue: "",
    ackReactionPromise: null,
  });
  const runtime = createSlackProgressRuntime({
    setup,
    delivery: createSlackStreamingDeliveryRuntime(setup),
  });
  return { runtime, api, merge: vi.spyOn(runtime.progressDraft, "mergeReasoningProgress") };
}

describe("Slack reasoning with no preview", () => {
  it("does no accumulated reasoning work when streaming is off", async () => {
    const { runtime, api, merge } = await fixture("off");
    try {
      expect(runtime.progressDraftActive).toBe(false);
      for (let index = 0; index < 64; index++) {
        expect(await runtime.pushReasoningProgress({ text: "reasoning ".repeat(8) })).toBe(false);
      }
      expect(merge).not.toHaveBeenCalled();
      expect(api).not.toHaveBeenCalled();
    } finally {
      await runtime.cancel();
    }
  });

  it("retains reasoning updates when the portable preview is enabled", async () => {
    const { runtime, merge } = await fixture("partial");
    try {
      expect(runtime.progressDraftActive).toBe(true);
      await runtime.pushReasoningProgress({ text: "Checking the result." });
      expect(merge).toHaveBeenCalled();
      expect(runtime.draftStream?.update).toHaveBeenCalled();
    } finally {
      await runtime.cancel();
      await runtime.draftStream?.seal();
    }
  });
});
