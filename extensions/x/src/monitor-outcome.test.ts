import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { xPlugin } from "./channel.js";
import { XConfigSchema } from "./config-schema.js";
import { completedMonitor } from "./test-support/completed-monitor.js";
import { client, config, fixture, post } from "./test-support/monitor-fixture.js";
import { openXWorkOrigins, registerXWorkOriginGuidance } from "./work-origin.js";

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
const routedText = (index = 0) => routeSend.mock.calls[index]![0].payloads[0]!.text;

// Verbatim shape of a deleted public tweet: model prose, not an isError payload.
const deletedTweet =
  "Tried to open the dev-gateway and narrated-video session, but session creation failed: 'X runtime not initialized.' No work session was created; please resend.";
const failureRoute = { channel: "discord", to: "channel:1456744319972282449" };

beforeEach(() => {
  client.getXApi.mockReset();
  routeSend.mockClear();
});
afterEach(() => clearRuntimeConfigSnapshot());

async function runTurn(
  finals: ReplyPayload[],
  { route = true, visibleSessionUrl }: { route?: boolean; visibleSessionUrl?: string | null } = {},
) {
  const cfg: OpenClawConfig = structuredClone(config);
  if (route) {
    cfg.channels!.x!.failureRoute = failureRoute;
  }
  const test = completedMonitor({ cfg, finals, visibleSessionUrl });
  await test.run();
  return test;
}

describe("X reply outcomes", () => {
  it("rejects a failure route that targets X", () => {
    expect(XConfigSchema.safeParse({ failureRoute }).success).toBe(true);
    expect(XConfigSchema.safeParse({ failureRoute: { channel: "x", to: "x:1" } }).success).toBe(
      false,
    );
  });

  it("withholds an untagged failure narrative from X and drops it without a route", async () => {
    const test = await runTurn([{ text: deletedTweet }], { route: false });
    expect(test.api.reply).not.toHaveBeenCalled();
    expect(routeSend).not.toHaveBeenCalled();
  });

  it.each([false, true])("withholds errors with status flag %s", async (isStatusNotice) => {
    const text = "Your message is queued for a new turn after the current turn finishes.";
    const test = await runTurn(
      [
        { text, isStatusNotice: true },
        { text: deletedTweet },
        { text: "⚠️ Agent failed before reply", isError: true, isStatusNotice },
        { text: "NO_REPLY" },
        { text: "[[x_success]]" },
        { text: "   " },
      ],
      { visibleSessionUrl: null },
    );
    expect(test.replies).toEqual([{ text, parent: "501" }]);
    expect(routeSend).toHaveBeenCalledTimes(2);
    expect(routedText()).toContain("(no success tag)");
    expect(routedText(1)).toContain("(error reply)");
    expect(test.logger.info).toHaveBeenCalledWith("reply dropped post=501 reason=silent");
    expect(test.logger.info).toHaveBeenCalledWith("reply dropped post=501 reason=empty");
  });

  it("routes a redacted failure and keeps later success and untagged finals withheld", async () => {
    const test = await runTurn([
      {
        text: "[[x_failure]] I tried to open a worktree session for Token Pass support, but session creation failed. @everyone token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      },
      { text: "[[x_success]] Done after all." },
      { text: "Untagged follow-up." },
    ]);
    expect(test.api.reply).not.toHaveBeenCalled();
    expect(routeSend).toHaveBeenCalledTimes(3);
    const send = routeSend.mock.calls[0]![0];
    expect(send).toMatchObject({ channel: "discord", to: "channel:1456744319972282449" });
    const text = send.payloads[0]!.text!;
    expect(text.split("\n")[0]).toBe(
      "X reply withheld (reported failure) for @config_maintainer: https://x.com/config_maintainer/status/501",
    );
    expect(text).toContain("session creation failed.");
    expect(text).not.toMatch(
      /\[\[x_failure\]\]|ghp_abcdefghijklmnopqrstuvwxyz0123456789|@everyone/,
    );
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
});

describe("X work-origin replies", () => {
  const child = "agent:maintainer:work:example";
  const descendant = "agent:worker:dashboard:descendant";
  const helper = "agent:worker:subagent:helper";
  const origin: Parameters<ReturnType<typeof openXWorkOrigins>["registerIfAbsent"]>[1] = {
    accountId: "default",
    postId: "501",
    postUrl: "https://x.com/config_maintainer/status/501",
    authorHandle: "config_maintainer",
    conversationId: "500",
    senderTier: "maintainer",
  };
  const expectedGuidance =
    'X origin: @config_maintainer https://x.com/config_maintainer/status/501\nReplies are manual: draft ≤280 characters with the result and any PR link; show the user and ask. Post only after explicit approval in this session. Use tool message: {action:"send", channel:"x", target:"https://x.com/config_maintainer/status/501", accountId:"default", message:"<approved reply>"}. When useful, attach inspected proof images or video natively with media:"<approved file or URL>" rather than a sign-in-only link; show the attachment with the caption for approval. If unanswered, remind once at the end of your final summary.';

  async function originFixture(posts: Parameters<typeof fixture>[0]["posts"] = []) {
    const test = fixture({ posts });
    Object.assign(test.runtime, { config: { current: () => config } });
    for (const [sessionKey, spawnedBy] of [
      [descendant, helper],
      [helper, child],
    ] as const) {
      test.sessionEntries.set(sessionKey, {
        sessionId: sessionKey,
        updatedAt: 1,
        createdVia: "spawn",
        spawnedBy,
      });
    }
    await openXWorkOrigins(test.runtime).registerIfAbsent(child, origin);
    return test;
  }

  function guidance(test: ReturnType<typeof fixture>) {
    const on = vi.fn<OpenClawPluginApi["on"]>();
    registerXWorkOriginGuidance({ on, runtime: test.runtime });
    const handler = on.mock.calls[0]![1] as (
      event: { prompt: string; messages: unknown[] },
      ctx: { sessionKey?: string },
    ) => Promise<{ appendSystemContext: string } | undefined>;
    return (ctx: { sessionKey?: string }, prompt = "hello", messages: unknown[] = []) =>
      handler({ prompt, messages }, ctx);
  }

  function send(sessionKey: string, to: string, message: string, params = {}) {
    return xPlugin.actions!.handleAction!({
      channel: "x",
      action: "send",
      cfg: config,
      sessionKey,
      params: { to, message, ...params },
    });
  }

  it.each([child, descendant])("contributes exact stable guidance to %s", async (sessionKey) => {
    const test = await originFixture();
    const store = openXWorkOrigins(test.runtime);
    await store.registerIfAbsent(child, { ...origin, postId: "502", authorHandle: "other" });
    const handler = guidance(test);
    const expected = { appendSystemContext: expectedGuidance };
    expect(await handler({ sessionKey }, "first task")).toEqual(expected);
    expect(await handler({ sessionKey }, "post the draft", [{ role: "user" }])).toEqual(expected);
    expect(await store.lookup(sessionKey)).toEqual(origin);
    expect(await handler({ sessionKey: "unrelated" })).toBeUndefined();
    expect(await handler({})).toBeUndefined();
  });

  it.each([child, descendant])(
    "limits %s replies to mentions in the origin conversation",
    async (sessionKey) => {
      const posts = ["500", "600"].map((conversation_id, index) =>
        Object.assign(post(String(502 + index), "10"), {
          conversation_id,
          entities: { mentions: [{ id: "100", username: "roboclawbot" }] },
        }),
      );
      const test = await originFixture(posts);
      await send(sessionKey, "https://x.com/config_maintainer/status/502", "Fixed.");
      await expect(send(sessionKey, "x:503", "Unrelated")).rejects.toThrow(
        "only to its origin post",
      );
      expect(test.replies).toEqual([{ text: "Fixed.", parent: "502" }]);
    },
  );

  it("does not accept a quote-only sibling or model-supplied session identity", async () => {
    const sibling = {
      ...post("502", "10"),
      entities: { mentions: [{ id: "999", username: "someone_else" }] },
      referenced_tweets: [{ type: "quoted" as const, id: "600" }],
    };
    const test = await originFixture([sibling]);
    test.api.getPosts.mockResolvedValue({
      data: [sibling],
      includes: { users: [], tweets: [post("600", "100")] },
      meta: {},
    });
    const reply = send(child, "x:502", "Unrelated quote", { sessionKey: "unrelated" });
    await expect(reply).rejects.toThrow("only replies to posts");
    expect(test.api.reply).not.toHaveBeenCalled();
  });

  it("keeps front-door sends unrestricted by child origins, rejecting only declared failures", async () => {
    const test = await originFixture([
      { ...post("503", "10"), entities: { mentions: [{ id: "100", username: "roboclawbot" }] } },
    ]);
    const reply = (text: string) => send("agent:maintainer:x:group:500", "x:503", text);
    await expect(reply("[[x_failure]] Could not finish.")).rejects.toThrow(
      "X does not post failure replies",
    );
    await reply("I am on it.");
    await reply("[[x_success]] Fixed in the linked PR.");
    expect(test.replies).toEqual([
      { text: "I am on it.", parent: "503" },
      { text: "Fixed in the linked PR.", parent: "503" },
    ]);
  });
});
