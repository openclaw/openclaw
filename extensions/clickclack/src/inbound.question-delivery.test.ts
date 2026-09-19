// Covers ask_user prompts leaving an inbound ClickClack turn as question cards.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { buildAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { expect, it, vi } from "vitest";
import { handleClickClackInbound } from "./inbound.js";
import { setClickClackRuntime } from "./runtime.js";
import type { ClickClackMessage, CoreConfig, ResolvedClickClackAccount } from "./types.js";

const hoisted = vi.hoisted(() => ({
  sendText: vi.fn(),
  deliverQuestion: vi.fn(
    async (_params: { payload: unknown; to: string; lifetime: unknown }) => false,
  ),
}));

vi.mock("./outbound.js", () => ({ sendClickClackText: hoisted.sendText }));
vi.mock("./questions.js", () => ({ deliverClickClackQuestionPrompt: hoisted.deliverQuestion }));

function createRuntime(): PluginRuntime {
  const runtime = createPluginRuntimeMock({
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(resolveAgentRoute),
        buildAgentSessionKey: vi.fn(buildAgentSessionKey),
      },
    },
  } as unknown as PluginRuntime);
  const stores = new Map<string, PluginStateSyncKeyedStore<unknown>>();
  runtime.state.openSyncKeyedStore = vi.fn((options: { namespace: string }) => {
    const values = new Map<string, unknown>();
    const store = stores.get(options.namespace) ?? {
      register: (key: string, value: unknown) => values.set(key, value),
      registerIfAbsent: (key: string, value: unknown) =>
        values.has(key) ? false : Boolean(values.set(key, value)),
      lookup: (key: string) => values.get(key),
      consume: (key: string) => values.get(key),
      delete: (key: string) => values.delete(key),
      entries: () => [],
      clear: () => values.clear(),
    };
    stores.set(options.namespace, store as PluginStateSyncKeyedStore<unknown>);
    return store;
  }) as unknown as PluginRuntime["state"]["openSyncKeyedStore"];
  return runtime;
}

const account = {
  accountId: "default",
  enabled: true,
  configured: true,
  baseUrl: "http://127.0.0.1:8080",
  apiEndpoint: "http://127.0.0.1:8080",
  token: "test-token-placeholder",
  workspace: "wsp_1",
  replyMode: "agent",
  toolsAllow: [],
  defaultTo: "channel:general",
  allowFrom: ["*"],
  allowBots: false,
  reconnectMs: 1_500,
  agentActivity: false,
  nativeProgress: false,
  commandMenu: true,
  discussions: { enabled: false, workspace: "wsp_1", section: "Sessions" },
  requireMention: false,
  mentionPatterns: [],
  groups: {},
  config: { allowFrom: ["*"] },
} satisfies ResolvedClickClackAccount;

const message: ClickClackMessage = {
  id: "msg_01arz3ndektsv4rrffq69g5fav",
  workspace_id: "wsp_1",
  channel_id: "chn_1",
  author_id: "usr_owner",
  thread_root_id: "msg_01arz3ndektsv4rrffq69g5fav",
  body: "@bot plan the order",
  body_format: "markdown",
  created_at: "2026-05-09T12:00:00.000Z",
  author: {
    id: "usr_owner",
    kind: "human",
    display_name: "Owner",
    handle: "owner",
    avatar_url: "",
    created_at: "2026-05-09T12:00:00.000Z",
  },
};

it("sends ask_user prompts as question cards and other replies as text", async () => {
  const runtime = createRuntime();
  setClickClackRuntime(runtime);
  const questionLifetime = {
    cfg: {} as CoreConfig,
    account,
    abortSignal: new AbortController().signal,
    runInAccountContext: <T>(run: () => T) => run(),
  };
  await handleClickClackInbound({ account, config: {} as CoreConfig, questionLifetime, message });
  const delivery = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0]?.[0].delivery;
  const prompt = {
    text: "Pick a date",
    channelData: { askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" } },
  };

  hoisted.deliverQuestion.mockResolvedValueOnce(true);
  await delivery?.deliver(prompt, { kind: "tool" } as never);
  await delivery?.deliver({ text: "Done." }, { kind: "final" } as never);

  expect(hoisted.deliverQuestion.mock.calls.map(([call]) => [call.payload, call.to])).toEqual([
    [prompt, "channel:chn_1"],
    [{ text: "Done." }, "channel:chn_1"],
  ]);
  expect(hoisted.deliverQuestion.mock.calls[0]?.[0].lifetime).toBe(questionLifetime);
  expect(hoisted.sendText).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: "Done.", replyToId: message.id, to: "channel:chn_1" }),
  );
});
