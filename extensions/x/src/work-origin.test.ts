import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { xPlugin } from "./channel.js";
import { client, config, fixture, post } from "./test-support/monitor-fixture.js";
import { openXWorkOrigins, registerXWorkOriginGuidance } from "./work-origin.js";

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  getXApi: vi.fn(),
  getXTokenState: () => "ready",
}));

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

beforeEach(() => client.getXApi.mockReset());
afterEach(() => clearRuntimeConfigSnapshot());
function installSpawnLineage(test: ReturnType<typeof fixture>) {
  const entries: Record<string, { createdVia: "spawn"; spawnedBy: string }> = {
    [descendant]: { createdVia: "spawn", spawnedBy: helper },
    [helper]: { createdVia: "spawn", spawnedBy: child },
  };
  Object.assign(test.runtime, { config: { current: () => config } });
  Object.assign(test.runtime.agent.session, {
    getSessionEntryAsync: async ({ sessionKey }: { sessionKey: string }) => entries[sessionKey],
  });
}

async function originFixture(posts: Parameters<typeof fixture>[0]["posts"] = []) {
  const test = fixture({ posts });
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
  installSpawnLineage(test);
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

it.each(
  [
    { target: "501", conversation: "500", allowed: true },
    { target: "502", conversation: "500", allowed: true },
    { target: "503", conversation: "600", allowed: false },
  ].flatMap((scenario) =>
    ["action", "outbound"].flatMap((route) =>
      [child, descendant].map((sessionKey) => Object.assign({ route, sessionKey }, scenario)),
    ),
  ),
)(
  "limits $sessionKey replies to origin/conversation: $target via $route",
  async ({ target, conversation, allowed, route, sessionKey }) => {
    const mention = {
      ...post(target, "10"),
      conversation_id: conversation,
      entities: { mentions: [{ id: "100", username: "roboclawbot" }] },
    };
    const test = await originFixture([mention]);
    installSpawnLineage(test);
    const reply =
      route === "action"
        ? send(sessionKey, `https://x.com/config_maintainer/status/${target}`, "Fixed.")
        : xPlugin.outbound!.sendText!({
            cfg: config,
            to: `x:${target}`,
            text: "Fixed.",
            sessionKey,
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

it("leaves the front door's reply path unrestricted by a child's origin", async () => {
  const test = await originFixture([
    { ...post("503", "10"), entities: { mentions: [{ id: "100", username: "roboclawbot" }] } },
  ]);
  await send("agent:maintainer:x:group:500", "x:503", "I am on it.");
  expect(test.replies).toEqual([{ text: "I am on it.", parent: "503" }]);
});
