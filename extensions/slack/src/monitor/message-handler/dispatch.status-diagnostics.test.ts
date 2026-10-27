import { WebClient, type WebAPICallResult } from "@slack/web-api";
import { resolveChannelInboundRouteEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import type { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeSlackReaction } from "../../actions.js";
import { createSlackDispatchSetup } from "./dispatch-setup.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";

type PipelineOptions = Parameters<typeof createChannelMessageReplyPipeline>[0];
let capturedTyping: PipelineOptions["typing"];
vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    createChannelMessageReplyPipeline: (options: PipelineOptions) => {
      capturedTyping = options.typing;
      return { onModelSelected: vi.fn() };
    },
  };
});
vi.mock("../../actions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../actions.js")>()),
  reactSlackMessage: vi.fn(async () => undefined),
  removeSlackReaction: vi.fn(async () => undefined),
}));

async function fixture(active: WebAPICallResult | Error = { ok: true }, typingReaction = false) {
  const client = new WebClient();
  const api = vi.spyOn(client, "apiCall").mockImplementation(async (method, args) => {
    if (method === "agents.sessions.rename") {
      return { ok: false };
    }
    const response = args?.status === "processing" ? { ok: true } : active;
    return response instanceof Error ? Promise.reject(response) : response;
  });
  const ctx = createInboundSlackTestContext({ cfg: {}, appClient: client, replyToMode: "all" });
  const error = vi.fn();
  ctx.runtime.error = error;
  ctx.typingReaction = typingReaction ? "hourglass_flowing_sand" : "";
  const { route } = resolveChannelInboundRouteEnvelope({
    cfg: {},
    channel: "slack",
    accountId: "default",
    peer: { kind: "group", id: "C1" },
  });
  await createSlackDispatchSetup({
    ctx,
    account: createSlackTestAccount({ streaming: { mode: "off" } }),
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
  const typing = capturedTyping;
  if (!typing?.start || !typing.stop) {
    throw new Error("registered typing callbacks missing");
  }
  return { ctx, api, error, start: typing.start, stop: typing.stop };
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedTyping = undefined;
});
afterEach(() => vi.restoreAllMocks());

describe("Slack terminal status diagnostics", () => {
  it("reports terminal failures once without private details after accepted processing", async () => {
    const f = await fixture(new Error("synthetic-private-detail"));
    await f.start();
    await f.start();
    await f.stop();
    await f.stop();
    expect(f.error).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    const diagnostic = f.error.mock.calls.flat().join(" ");
    expect(diagnostic).not.toMatch(/synthetic-private-detail|C1|1\.000|xoxb-test/);
    expect(f.api).toHaveBeenCalledTimes(2);
  });

  it("cleans up typing reactions after status restoration fails", async () => {
    const f = await fixture({ ok: false }, true);
    await f.start();
    await expect(f.stop()).resolves.toBeUndefined();
    expect(removeSlackReaction).toHaveBeenCalledOnce();
  });

  it("does not turn a failed rename into a failed accepted processing write", async () => {
    const f = await fixture();
    expect(
      await f.ctx.setSlackSessionStatus({
        channelId: "C1",
        threadTs: "1.000",
        status: "processing",
        title: "New label",
      }),
    ).toBe(true);
    expect(f.api).toHaveBeenCalledTimes(2);
  });
});
