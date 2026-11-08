import assert from "node:assert/strict";
import type { Update } from "grammy/types";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";

export type TestTelegramMessageUpdate = Update & {
  message: NonNullable<Update["message"]> & { text: string };
};

export const waitForWebhookState = <T>(
  assertion: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) => vi.waitFor(assertion, { interval: 1, ...options });

export function telegramMessageUpdate(updateId: number, text: string): TestTelegramMessageUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_736_380_800,
      from: { id: 111, is_bot: false, first_name: "Ada" },
      chat: { id: 111, type: "private", first_name: "Ada" },
      text,
    },
  };
}

export function createNearLimitTelegramPayload(): { payload: string; sizeBytes: number } {
  // Just under 1 MiB, including the message envelope.
  const text = "the quick brown fox jumps over the lazy dog ".repeat(23_730);
  const payload = JSON.stringify(telegramMessageUpdate(77_777, text));
  return { payload, sizeBytes: Buffer.byteLength(payload, "utf-8") };
}

export function expectSingleNearLimitUpdate(params: {
  seenUpdates: TestTelegramMessageUpdate[];
  expected: TestTelegramMessageUpdate;
}) {
  expect(params.seenUpdates).toMatchObject([
    { update_id: params.expected.update_id, message: { text: params.expected.message.text } },
  ]);
}

type MockCallReader = { mock: { calls: unknown[][] } };

export const requireRecord = createRequireRecord("record", "expected-label-object");

export function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as MockCallReader).mock.calls.at(index);
  assert(call, `expected ${label} call ${index}`);
  return call;
}

export function expectStatusCall(mock: unknown, expected: Record<string, unknown>) {
  const match = (mock as MockCallReader).mock.calls
    .map((call) => requireRecord(call[0], "status call"))
    .find((status) => Object.entries(expected).every(([key, value]) => status[key] === value));
  assert(match, `expected status call containing ${JSON.stringify(expected)}`);
  return match;
}

export function createTelegramPrivateTopicCallback(updateId: number, botId: number) {
  return {
    id: `callback-${updateId}`,
    data: "cmd:option_a",
    chat_instance: "telegram-private-chat-1234",
    from: { id: 111, is_bot: false as const, first_name: "Ada" },
    message: {
      chat: { id: 1234, type: "private" as const },
      date: 1_736_380_800,
      from: { id: botId, is_bot: true as const, first_name: "OpenClaw" },
      message_id: 10,
      message_thread_id: 42,
    },
  };
}

export function expectWebhookBotScopesAborted(createTelegramBotSpy: unknown): void {
  const call = requireMockCall(createTelegramBotSpy, 0, "createTelegramBot")[0];
  const botParams = requireRecord(call, "createTelegramBot params");
  for (const signal of [botParams.fetchAbortSignal, botParams.accountAbortSignal]) {
    assert(signal instanceof AbortSignal && signal.aborted, "expected an aborted AbortSignal");
  }
}

export const telegramWebhookListenerCases = (
  [
    ["omitted", undefined, undefined],
    ["omitted with public origin fallback", undefined, ""],
    ["explicit", { port: 9000 }, undefined],
    ["disabled", false, undefined],
  ] as const
).map(([name, legacyWebhook, publicUrl = "https://callback.example.test/hook"]) => ({
  name,
  legacyWebhook,
  endpoint: legacyWebhook ? { ...legacyWebhook, host: "127.0.0.1" } : undefined,
  publicUrl,
  advertisedUrl: publicUrl || "https://gateway.example.test/hook",
}));

export const telegramReservedGatewayPaths = ["health", "ready", "startup"]
  .flatMap((path) => [`/${path}`, `/${path}z`])
  .flatMap((path) => [path, `${path}?token=known`]);
