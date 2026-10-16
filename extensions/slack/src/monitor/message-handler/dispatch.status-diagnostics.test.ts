import { WebClient, type WebAPICallResult } from "@slack/web-api";
import { resolveChannelInboundRouteEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeSlackReaction } from "../../actions.js";
import { createSlackDispatchSetup } from "./dispatch-setup.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";
import type { PreparedSlackMessage } from "./types.js";

type SlackSessionStatus = "processing" | "active" | "suspended" | "closed";
type SlackSessionResponse = WebAPICallResult & {
  status?: SlackSessionStatus;
  agent_status?: SlackSessionStatus;
};

type PipelineOptions = Parameters<
  typeof import("openclaw/plugin-sdk/channel-outbound").createChannelMessageReplyPipeline
>[0];
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

async function fixture(
  params: {
    processing?: SlackSessionResponse;
    active?: SlackSessionResponse | Error;
    typingReaction?: boolean;
  } = {},
) {
  const client = new WebClient();
  const api = vi.spyOn(client, "apiCall").mockImplementation(async (method, args) => {
    if (method === "agents.sessions.rename") {
      return { ok: false };
    }
    const response =
      args?.status === "processing"
        ? (params.processing ?? { ok: true })
        : (params.active ?? { ok: true });
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });
  const ctx = createInboundSlackTestContext({ cfg: {}, appClient: client, replyToMode: "all" });
  const error = vi.fn();
  ctx.runtime.error = error;
  ctx.runtime.log = vi.fn();
  ctx.typingReaction = params.typingReaction ? "hourglass_flowing_sand" : "";
  const { route } = resolveChannelInboundRouteEnvelope({
    cfg: {},
    channel: "slack",
    accountId: "default",
    peer: { kind: "group", id: "C1" },
  });
  const prepared: PreparedSlackMessage = {
    ctx,
    account: createSlackTestAccount({ streaming: { mode: "off" } }),
    message: {
      type: "message",
      channel: "C1",
      user: "U1",
      ts: "1.000",
      thread_ts: "1.000",
      text: "hello",
    },
    route,
    channelConfig: null,
    replyTarget: "channel:C1",
    ctxPayload: {
      Body: "hello",
      CommandAuthorized: false,
      ChatType: "group",
      SessionKey: route.sessionKey,
      OriginatingTo: "channel:C1",
      MessageThreadId: "1.000",
    },
    turn: { record: {} },
    replyToMode: "all",
    isDirectMessage: false,
    isRoomish: true,
    ackReactionValue: "",
    ackReactionPromise: null,
  };
  await createSlackDispatchSetup(prepared);
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
    const f = await fixture({ active: new Error("synthetic-private-detail") });
    await f.start();
    await f.start();
    await f.stop();
    await f.stop();
    expect(f.error).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    expect(f.error.mock.calls.flat().join(" ")).not.toMatch(
      /synthetic-private-detail|C1|1\.000|xoxb-test/,
    );
    expect(f.api).toHaveBeenCalledTimes(2);
  });

  it("continues typing-reaction cleanup if the diagnostic logger throws", async () => {
    const f = await fixture({ active: { ok: false }, typingReaction: true });
    f.error.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
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
