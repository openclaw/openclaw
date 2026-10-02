import { createHash } from "node:crypto";
import type { Update } from "grammy/types";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";

export type TestTelegramMessageUpdate = Update & {
  message: NonNullable<Update["message"]> & { text: string };
};

export async function waitForWebhookState<T>(
  assertion: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  return await vi.waitFor(assertion, { interval: 1, ...options });
}

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
  const maxBytes = 1_024 * 1_024;
  const targetBytes = maxBytes - 4_096;
  const shell = telegramMessageUpdate(77_777, "");
  const shellSize = Buffer.byteLength(JSON.stringify(shell), "utf-8");
  const textLength = Math.max(1, targetBytes - shellSize);
  const pattern = "the quick brown fox jumps over the lazy dog ";
  const repeats = Math.ceil(textLength / pattern.length);
  const text = pattern.repeat(repeats).slice(0, textLength);
  const payload = JSON.stringify(telegramMessageUpdate(77_777, text));
  return { payload, sizeBytes: Buffer.byteLength(payload, "utf-8") };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function expectSingleNearLimitUpdate(params: {
  seenUpdates: TestTelegramMessageUpdate[];
  expected: TestTelegramMessageUpdate;
}) {
  expect(params.seenUpdates).toHaveLength(1);
  expect(params.seenUpdates[0]?.update_id).toBe(params.expected.update_id);
  expect(params.seenUpdates[0]?.message.text.length).toBe(params.expected.message.text.length);
  expect(sha256(params.seenUpdates[0]?.message.text ?? "")).toBe(
    sha256(params.expected.message.text),
  );
}

type MockCallReader = { mock: { calls: unknown[][] } };

export const requireRecord = createRequireRecord("record", "expected-label-object");

export function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as MockCallReader).mock.calls.at(index);
  if (!call) {
    throw new Error(`expected ${label} call ${index}`);
  }
  return call;
}

function mockMessages(mock: unknown): string[] {
  return (mock as MockCallReader).mock.calls.map((call) => {
    const message = call[0];
    return typeof message === "string" ? message : "";
  });
}

export function expectMockMessageContains(mock: unknown, expected: string): void {
  expect(mockMessages(mock).join("\n")).toContain(expected);
}

export function expectStatusCall(
  mock: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  const match = (mock as MockCallReader).mock.calls
    .map((call) => requireRecord(call[0], "status call"))
    .find((status) => Object.entries(expected).every(([key, value]) => status[key] === value));
  if (!match) {
    throw new Error(`expected status call containing ${JSON.stringify(expected)}`);
  }
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
  const botParams = requireRecord(
    requireMockCall(createTelegramBotSpy, 0, "createTelegramBot")[0],
    "createTelegramBot params",
  );
  for (const key of ["fetchAbortSignal", "accountAbortSignal"]) {
    const signal = botParams[key];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect((signal as AbortSignal).aborted).toBe(true);
  }
}

export const telegramWebhookListenerCases = [
  { name: "implicit", legacyWebhook: undefined, endpoint: { port: 8787, host: "127.0.0.1" } },
  { name: "explicit", legacyWebhook: { port: 9000 }, endpoint: { port: 9000, host: "127.0.0.1" } },
  { name: "disabled", legacyWebhook: false, endpoint: undefined },
] as const;

export const telegramReservedGatewayPaths = [
  "/health",
  "/healthz",
  "/ready",
  "/readyz",
  "/startup",
  "/startupz",
].flatMap((path) => [path, `${path}?token=known`]);
