import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { xPlugin } from "./channel.js";
import { client, config, fixture, post } from "./test-support/monitor-fixture.js";
import { openXWorkOrigins, registerXWorkOriginGuidance, type XWorkOrigin } from "./work-origin.js";

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  getXApi: vi.fn(),
  getXTokenState: () => "ready",
}));

const child = "agent:maintainer:work:example";
const origin: XWorkOrigin = {
  accountId: "default",
  postId: "501",
  postUrl: "https://x.com/config_maintainer/status/501",
  authorHandle: "config_maintainer",
  conversationId: "500",
  senderTier: "maintainer",
};
const expectedGuidance =
  'This session was started from an X post by @config_maintainer: https://x.com/config_maintainer/status/501. Replies to X are manual. Never post to X on your own. When you have a result worth sharing (finding, fix, PR, or a clear "can\'t reproduce"), draft a reply of at most 280 characters with the key result and any PR link, show it to the user, and ask whether to post it. Post only after the user explicitly says so in this session, using the message tool with channel "x" and that post URL as the target. If the user has not answered, remind them once at the end of your final summary.';

beforeEach(() => client.getXApi.mockReset());
afterEach(() => clearRuntimeConfigSnapshot());

describe("X work-session origin", () => {
  it("contributes exact stable system guidance only to the recorded session", async () => {
    const test = fixture({ posts: [] });
    const store = openXWorkOrigins(test.runtime);
    await store.registerIfAbsent(child, origin);
    await store.registerIfAbsent(child, { ...origin, postId: "502", authorHandle: "other" });
    const on = vi.fn<OpenClawPluginApi["on"]>();
    registerXWorkOriginGuidance({ on, runtime: test.runtime });
    // The fixture invokes only this registration's documented prompt-hook contract.
    const handler = on.mock.calls[0]![1] as (
      event: { prompt: string; messages: unknown[] },
      ctx: { sessionKey?: string },
    ) => Promise<{ appendSystemContext: string } | undefined>;
    expect(await handler({ prompt: "first task", messages: [] }, { sessionKey: child })).toEqual({
      appendSystemContext: `${expectedGuidance}\nUse accountId "default" for that message-tool reply.`,
    });
    expect(
      await handler(
        { prompt: "post the draft", messages: [{ role: "user" }] },
        { sessionKey: child },
      ),
    ).toEqual({
      appendSystemContext: `${expectedGuidance}\nUse accountId "default" for that message-tool reply.`,
    });
    expect(
      await handler({ prompt: "hello", messages: [] }, { sessionKey: "unrelated" }),
    ).toBeUndefined();
    expect(await handler({ prompt: "hello", messages: [] }, {})).toBeUndefined();
  });

  it.each(
    [
      { target: "501", conversation: "500", allowed: true },
      { target: "502", conversation: "500", allowed: true },
      { target: "503", conversation: "600", allowed: false },
    ].flatMap(({ target, conversation, allowed }) =>
      ["action", "outbound"].map((route) => ({ target, conversation, allowed, route })),
    ),
  )(
    "limits child replies to origin/conversation: $target via $route",
    async ({ target, conversation, allowed, route }) => {
      const mention = {
        ...post(target, "10"),
        conversation_id: conversation,
        entities: { mentions: [{ id: "100", username: "roboclawbot" }] },
      };
      const test = fixture({ posts: [mention] });
      await openXWorkOrigins(test.runtime).registerIfAbsent(child, origin);
      const reply =
        route === "action"
          ? xPlugin.actions!.handleAction!({
              channel: "x",
              action: "send",
              cfg: config,
              sessionKey: child,
              params: { to: `https://x.com/config_maintainer/status/${target}`, message: "Fixed." },
            })
          : xPlugin.outbound!.sendText!({
              cfg: config,
              to: `x:${target}`,
              text: "Fixed.",
              sessionKey: child,
            });
      if (allowed) {
        await expect(reply).resolves.toBeDefined();
        expect(test.replies).toEqual([{ text: "Fixed.", parent: target }]);
      } else {
        await expect(reply).rejects.toThrow("only to its origin post");
        expect(test.replies).toEqual([]);
      }
    },
  );

  it("does not accept a quote-only sibling or model-supplied session identity", async () => {
    const sibling = {
      ...post("502", "10"),
      entities: { mentions: [{ id: "999", username: "someone_else" }] },
      referenced_tweets: [{ type: "quoted" as const, id: "600" }],
    };
    const test = fixture({ posts: [sibling] });
    test.api.getPosts.mockResolvedValue({
      data: [sibling],
      includes: { users: [], tweets: [post("600", "100")] },
      meta: {},
    });
    await openXWorkOrigins(test.runtime).registerIfAbsent(child, origin);
    await expect(
      xPlugin.actions!.handleAction!({
        channel: "x",
        action: "send",
        cfg: config,
        sessionKey: child,
        params: {
          to: "x:502",
          message: "Unrelated quote",
          sessionKey: "unrelated",
        },
      }),
    ).rejects.toThrow("only replies to posts");
    expect(test.api.reply).not.toHaveBeenCalled();
  });

  it("leaves the front door's reply path unrestricted by a child's origin", async () => {
    const test = fixture({
      posts: [
        { ...post("503", "10"), entities: { mentions: [{ id: "100", username: "roboclawbot" }] } },
      ],
    });
    await openXWorkOrigins(test.runtime).registerIfAbsent(child, origin);
    await xPlugin.actions!.handleAction!({
      channel: "x",
      action: "send",
      cfg: config,
      sessionKey: "agent:maintainer:x:group:500",
      params: { to: "x:503", message: "I am on it." },
    });
    expect(test.replies).toEqual([{ text: "I am on it.", parent: "503" }]);
  });
});
