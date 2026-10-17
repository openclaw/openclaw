import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { xPlugin } from "./channel.js";
import { XConfigSchema } from "./config-schema.js";
import { client, config, fixture, post, type Payload } from "./test-support/monitor-fixture.js";
import { createQueue } from "./test-support/monitor.js";

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  getXApi: vi.fn(),
  getXTokenState: () => "ready",
}));
vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>()),
  sendDurableMessageBatch: vi.fn(async () => ({ status: "sent", results: [], receipt: {} })),
}));
const routeSend = vi.mocked(sendDurableMessageBatch);

// Verbatim shape of a deleted public tweet: model prose, not an isError payload.
const deletedTweet =
  "Tried to open the dev-gateway and narrated-video session, but session creation failed: 'X runtime not initialized.' No work session was created; please resend.";
const failureRoute = { channel: "discord", to: "channel:1456744319972282449" };

beforeEach(() => {
  client.getXApi.mockReset();
  routeSend.mockClear();
});
afterEach(() => clearRuntimeConfigSnapshot());

async function runTurn(finals: ReplyPayload[], route = true) {
  const cfg: OpenClawConfig = structuredClone(config);
  if (route) {
    cfg.channels!.x!.failureRoute = failureRoute;
  }
  const completed = Promise.withResolvers<void>();
  const test = fixture({
    cfg,
    finals,
    posts: [post("501", "10")],
    queue: createQueue<Payload>({ onCompleted: () => completed.resolve() }),
  });
  test.start();
  try {
    await completed.promise;
  } finally {
    await test.stop();
  }
  return test;
}

describe("X reply outcomes", () => {
  it("withholds an untagged failure narrative from X and drops it without a route", async () => {
    const test = await runTurn([{ text: deletedTweet }], false);
    expect(test.api.reply).not.toHaveBeenCalled();
    expect(routeSend).not.toHaveBeenCalled();
    expect(test.logger.info).toHaveBeenCalledWith(
      "reply withheld post=501 reason=unclassified route=none",
    );
  });

  it("routes a declared failure through core outbound with the post, author, and a redacted summary", async () => {
    const test = await runTurn([
      {
        text: "[[x_failure]] I tried to open a worktree session for Token Pass support, but session creation failed. @everyone token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      },
    ]);
    expect(test.api.reply).not.toHaveBeenCalled();
    expect(routeSend).toHaveBeenCalledOnce();
    const send = routeSend.mock.calls[0]![0];
    expect(send).toMatchObject({ channel: "discord", to: "channel:1456744319972282449" });
    const text = send.payloads[0]!.text!;
    expect(text.split("\n")[0]).toBe(
      "X reply withheld (reported failure) for @config_maintainer: https://x.com/config_maintainer/status/501",
    );
    expect(text).toContain("session creation failed.");
    expect(text).not.toContain("[[x_failure]]");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text).not.toContain("@everyone");
    expect(test.logger.info).toHaveBeenCalledWith(
      "reply withheld post=501 reason=failure route=discord result=sent",
    );
  });

  it("routes isError finals and silently drops NO_REPLY and empty finals", async () => {
    const test = await runTurn([
      { text: "⚠️ Agent failed before reply", isError: true },
      { text: "NO_REPLY" },
      { text: "[[x_success]]" },
      { text: "   " },
    ]);
    expect(test.api.reply).not.toHaveBeenCalled();
    expect(routeSend).toHaveBeenCalledOnce();
    expect(routeSend.mock.calls[0]![0].payloads[0]!.text).toContain("(error reply)");
    expect(test.logger.info).toHaveBeenCalledWith("reply dropped post=501 reason=silent");
    expect(test.logger.info).toHaveBeenCalledWith("reply dropped post=501 reason=empty");
  });

  it("posts a declared success without its tag and keeps the work-session link", async () => {
    const test = await runTurn([{ text: "[[x_success]] Opened the work session for Token Pass." }]);
    expect(routeSend).not.toHaveBeenCalled();
    expect(test.replies).toEqual([
      {
        text: "Opened the work session for Token Pass.\nWork session (sign-in required): https://example.test/work/42",
        parent: "501",
      },
    ]);
  });

  it("keeps a turn failed once any final declares failure", async () => {
    const test = await runTurn([
      { text: "[[x_failure]] Session creation failed." },
      { text: "[[x_success]] Done after all." },
      { text: "Untagged follow-up." },
    ]);
    expect(test.api.reply).not.toHaveBeenCalled();
    expect(routeSend).toHaveBeenCalledTimes(3);
  });

  it("refuses declared failures and strips success tags on message-tool sends", async () => {
    const test = fixture({
      posts: [
        { ...post("503", "10"), entities: { mentions: [{ id: "100", username: "roboclawbot" }] } },
      ],
    });
    const send = (message: string) =>
      xPlugin.actions!.handleAction!({
        channel: "x",
        action: "send",
        cfg: config,
        sessionKey: "agent:maintainer:x:group:500",
        params: { to: "x:503", message },
      });
    await expect(send("[[x_failure]] Could not finish.")).rejects.toThrow(
      "X does not post failure replies",
    );
    await send("[[x_success]] Fixed in the linked PR.");
    expect(test.replies).toEqual([{ text: "Fixed in the linked PR.", parent: "503" }]);
  });

  it("rejects a failure route that targets X", () => {
    expect(XConfigSchema.safeParse({ failureRoute }).success).toBe(true);
    expect(XConfigSchema.safeParse({ failureRoute: { channel: "x", to: "x:1" } }).success).toBe(
      false,
    );
  });
});
