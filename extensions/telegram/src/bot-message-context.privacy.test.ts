import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import { afterEach, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

afterEach(() => vi.restoreAllMocks());

it("keeps inbound, reply, and forwarded content out of verbose diagnostics", async () => {
  vi.spyOn(runtimeEnv, "shouldLogVerbose").mockReturnValue(true);
  const log = vi.spyOn(runtimeEnv, "logVerbose").mockImplementation(() => {});
  const message = {
    chat: { id: 1234, type: "private", first_name: "Pat" },
    from: { id: 1234, is_bot: false, first_name: "Pat" },
    message_id: 12,
    date: 1_700_000_012,
    text: "private-current-probe",
  };
  const ctx = await buildTelegramMessageContextForTest({
    message: {
      ...message,
      forward_origin: {
        type: "hidden_user",
        sender_user_name: "private-origin-probe",
        date: 1_699_999_000,
      },
      reply_to_message: { ...message, message_id: 10, text: "private-reply-probe" },
    },
  });
  expect(ctx?.ctxPayload.Body).toContain("private-current-probe");
  expect(ctx?.ctxPayload.Body).toContain("private-reply-probe");
  expect(ctx?.ctxPayload.Body).toContain("private-origin-probe");
  const diagnostics = log.mock.calls.map(([line]) => line).join("\n");
  expect(diagnostics).toContain("telegram inbound: chatId=1234");
  expect(diagnostics).not.toContain("private-");
});
