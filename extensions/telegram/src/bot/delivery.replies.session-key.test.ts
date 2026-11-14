import {
  addTestHook,
  createEmptyPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTelegramHttpFixture } from "../send.telegram-http.test-support.js";
import { deliverReplies } from "./delivery.js";

// Telegram message hooks carry the canonical runtime session key, like the core
// outbound path, so plugins can correlate sends with agent_end/llm_* events.
describe("telegram message hook session key", () => {
  const fixture = useTelegramHttpFixture();

  afterEach(() => {
    resetGlobalHookRunner();
    vi.restoreAllMocks();
  });

  async function observeSessionKeys(
    options: Partial<Parameters<typeof deliverReplies>[0]>,
  ): Promise<Record<"message_sending" | "message_sent", Array<string | undefined>>> {
    const seen = { message_sending: [], message_sent: [] } as Record<
      "message_sending" | "message_sent",
      Array<string | undefined>
    >;
    const registry = createEmptyPluginRegistry();
    for (const hookName of ["message_sending", "message_sent"] as const) {
      addTestHook({
        registry,
        pluginId: "session-key-proof",
        hookName,
        handler: (_event: unknown, ctx: { sessionKey?: string }) => {
          seen[hookName].push(ctx?.sessionKey);
        },
      });
    }
    initializeGlobalHookRunner(registry);
    await deliverReplies({
      cfg: fixture.cfg,
      bot: fixture.bot,
      runtime: fixture.runtime,
      chatId: "123",
      token: fixture.cfg.channels.telegram.botToken,
      replyToMode: "off",
      textLimit: 4000,
      replies: [{ text: "hello" }],
      ...options,
    });
    await vi.waitFor(() => expect(seen.message_sent).toHaveLength(1));
    return seen;
  }

  it("forwards the runtime session key to message_sending and message_sent", async () => {
    expect(
      await observeSessionKeys({ sessionKeyForInternalHooks: "agent:main:telegram:direct:123" }),
    ).toEqual({
      message_sending: ["agent:main:telegram:direct:123"],
      message_sent: ["agent:main:telegram:direct:123"],
    });
  });

  it("keeps the policy session key out of the hook session key", async () => {
    expect(await observeSessionKeys({ policySessionKey: "agent:main:telegram:group:456" })).toEqual(
      {
        message_sending: [undefined],
        message_sent: [undefined],
      },
    );
  });
});
