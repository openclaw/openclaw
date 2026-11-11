import {
  addTestHook,
  createEmptyPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTelegramHttpFixture } from "../send.telegram-http.test-support.js";
import { deliverReplies } from "./delivery.js";

// The message_sending hook context must carry the canonical runtime session
// key the same way the generic outbound path does, so plugins can correlate
// message_sending with agent_end/llm_input/llm_output events.
describe("telegram message_sending hook session key", () => {
  const fixture = useTelegramHttpFixture();
  const { cfg, runtime } = fixture;
  let bot: typeof fixture.bot;

  beforeEach(() => {
    ({ bot } = fixture);
  });

  afterEach(() => {
    resetGlobalHookRunner();
    vi.restoreAllMocks();
  });

  const deliver = (
    replies: Parameters<typeof deliverReplies>[0]["replies"],
    options: Partial<Parameters<typeof deliverReplies>[0]> = {},
  ) =>
    deliverReplies({
      cfg,
      bot,
      runtime,
      chatId: "123",
      token: cfg.channels.telegram.botToken,
      replyToMode: "off",
      textLimit: 4000,
      replies,
      ...options,
    });

  const observeHookSessionKeys = () => {
    const seen: Array<string | undefined> = [];
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      pluginId: "session-key-proof",
      hookName: "message_sending",
      handler: (_event: unknown, ctx: { sessionKey?: string }) => {
        seen.push(ctx?.sessionKey);
      },
    });
    initializeGlobalHookRunner(registry);
    return seen;
  };

  it("forwards the runtime session key to message_sending hooks", async () => {
    const seen = observeHookSessionKeys();
    await deliver([{ text: "hello" }], {
      sessionKeyForInternalHooks: "agent:main:telegram:direct:123",
    });
    expect(seen).toEqual(["agent:main:telegram:direct:123"]);
  });

  it("omits sessionKey when no runtime session is attached", async () => {
    const seen = observeHookSessionKeys();
    await deliver([{ text: "hello" }]);
    expect(seen).toEqual([undefined]);
  });

  it("keeps the policy session key out of the hook session key", async () => {
    const seen = observeHookSessionKeys();
    await deliver([{ text: "hello" }], {
      policySessionKey: "agent:main:telegram:group:456",
    });
    expect(seen).toEqual([undefined]);
  });
});
