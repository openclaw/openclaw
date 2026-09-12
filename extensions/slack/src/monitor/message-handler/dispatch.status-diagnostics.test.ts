// The registered Slack typing callbacks retain the real context and status API owners.
import { WebClient, type WebAPICallResult } from "@slack/web-api";
import {
  buildChannelInboundEventContext,
  resolveChannelInboundRouteEnvelope,
} from "openclaw/plugin-sdk/channel-inbound";
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
  const ctxPayload = buildChannelInboundEventContext({
    channel: "slack",
    accountId: "default",
    messageId: "1.000",
    from: "slack:channel:C1",
    sender: { id: "U1" },
    conversation: { kind: "group", id: "C1", threadId: "1.000" },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
    },
    reply: { to: "channel:C1", originatingTo: "channel:C1", messageThreadId: "1.000" },
    message: { body: "hello", bodyForAgent: "hello", rawBody: "hello", commandBody: "hello" },
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
    ctxPayload,
    turn: { storePath: "/unused/slack-status-test", record: {} },
    replyToMode: "all",
    requireMention: false,
    isDirectMessage: false,
    isRoomish: true,
    historyKey: "status-test",
    preview: "hello",
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
const diagnostic =
  "Slack session status could not return to active after processing. " +
  "Status was not retried; enable verbose logging to inspect the Slack API failure.";

beforeEach(() => {
  vi.clearAllMocks();
  capturedTyping = undefined;
});
afterEach(() => vi.restoreAllMocks());

describe("Slack terminal status diagnostics", () => {
  it("returns the real write outcome through monitor context", async () => {
    const f = await fixture({ active: { ok: false } });
    expect(
      await f.ctx.setSlackSessionStatus({
        channelId: "C1",
        threadTs: "1.000",
        status: "processing",
      }),
    ).toBe(true);
    expect(
      await f.ctx.setSlackSessionStatus({ channelId: "C1", threadTs: "1.000", status: "active" }),
    ).toBe(false);
  });

  it("reports a failed active write once after successful processing", async () => {
    const f = await fixture({ active: { ok: false } });
    await f.start();
    await f.stop();
    await f.stop();
    expect(f.error).toHaveBeenCalledExactlyOnceWith(diagnostic);
    expect(f.api).toHaveBeenCalledTimes(2);
  });

  it("reports a rejected Slack request without copying private error data to the normal log", async () => {
    const f = await fixture({ active: new Error("synthetic-private-detail") });
    await f.start();
    await f.stop();
    expect(f.error).toHaveBeenCalledExactlyOnceWith(diagnostic);
    expect(f.error.mock.calls.flat().join(" ")).not.toContain("synthetic-private-detail");
    expect(f.api).toHaveBeenCalledTimes(2);
  });

  it("keeps unsupported or failed processing writes quiet at normal level", async () => {
    const f = await fixture({ processing: { ok: false }, active: { ok: false } });
    await f.start();
    await f.stop();
    expect(f.error).not.toHaveBeenCalled();
    expect(f.api).toHaveBeenCalledTimes(2);
  });

  it("keeps successful transitions quiet", async () => {
    const f = await fixture();
    await f.start();
    await f.stop();
    expect(f.error).not.toHaveBeenCalled();
  });

  it("does not confuse aggregate processing with a failed active write", async () => {
    const f = await fixture({ active: { ok: true, status: "processing", agent_status: "active" } });
    await f.start();
    await f.stop();
    expect(f.error).not.toHaveBeenCalled();
  });

  it("does not attempt a status write when cleanup runs before start", async () => {
    const f = await fixture();
    await f.stop();
    expect(f.api).not.toHaveBeenCalled();
    expect(f.error).not.toHaveBeenCalled();
  });

  it("returns false without a request when there is no thread", async () => {
    const f = await fixture();
    expect(await f.ctx.setSlackSessionStatus({ channelId: "C1", status: "active" })).toBe(false);
    expect(f.api).not.toHaveBeenCalled();
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
