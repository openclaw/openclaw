import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import {
  guardAcpBoundReplyPlatformSend,
  registerSessionBindingAdapterV2,
  testing,
  type SessionBindingAdapterV2,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/session-binding-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTelegramHttpFixture } from "../send.telegram-http.test-support.js";
import { deliverReplies } from "./delivery.js";

const conversation = { channel: "telegram", accountId: "default", conversationId: "123" };
const authority = {
  targetSessionKey: "agent:codex-acp:child",
  bindingId: "b1",
  boundAt: 1,
  conversation,
};
const records = {
  bound: { ...authority, targetKind: "session", status: "active" },
  removed: null,
  reassigned: { ...authority, bindingId: "b2", targetSessionKey: "agent:other:x" },
};
type State = keyof typeof records;

/** Native (durable:false) Telegram send: the binding flips while media is still loading. */
describe("Telegram native ACP bound-child send", () => {
  const fixture = useTelegramHttpFixture();
  let current: SessionBindingRecord | null;

  beforeEach(() => {
    current = records.bound as unknown as SessionBindingRecord;
    const resolve = async () => current;
    registerSessionBindingAdapterV2({
      version: 2,
      channel: "telegram",
      accountId: "default",
      listBySession: () => [],
      listBySessionAsync: async () => [],
      resolveByConversation: () => current,
      resolveByConversationAsync: resolve,
      inspectByConversationAsync: resolve,
      inspectByConversationsAsync: async () => ({ bindings: [current], assertCurrent: () => {} }),
      touchAsync: async () => {},
      assertCurrent: () => {},
    } as SessionBindingAdapterV2);
  });
  afterEach(() => testing.resetSessionBindingAdaptersForTests());

  async function sendDuringMediaLoad(state: State) {
    const payload: ReplyPayload = setReplyPayloadMetadata(
      { text: "caption", mediaUrl: "file:///tmp/acp-proof.png" },
      { acpBindingAuthority: authority },
    );
    const result = await deliverReplies({
      cfg: fixture.cfg,
      bot: fixture.bot,
      runtime: fixture.runtime,
      chatId: "123",
      token: fixture.cfg.channels.telegram.botToken,
      replyToMode: "off",
      replies: [payload],
      textLimit: 4096,
      mediaLoader: async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
        current = records[state] as unknown as SessionBindingRecord | null; // race window
        return {
          buffer: Buffer.from("png bytes"),
          contentType: "image/png",
          kind: "image",
          fileName: "a.png",
        };
      },
      onPlatformSendDispatch: guardAcpBoundReplyPlatformSend(payload),
    }).catch((error: unknown) => ({ error: String(error) }));
    const sends = fixture.requests.filter(({ method }) => method.startsWith("send"));
    const outcome = "error" in result ? result.error : { delivered: result.delivered };
    console.log(
      `[proof] telegram native media ${state}:`,
      JSON.stringify({ sends: sends.map(({ method }) => method), outcome }),
    );
    return sends;
  }

  it.each(Object.keys(records) as State[])("revocation during media load, %s", async (state) => {
    const sends = await sendDuringMediaLoad(state);
    expect(sends.length > 0).toBe(state === "bound");
  });

  it("does not gate replies without an ACP binding", () => {
    expect(guardAcpBoundReplyPlatformSend({ text: "plain" })).toBeUndefined();
  });
});
