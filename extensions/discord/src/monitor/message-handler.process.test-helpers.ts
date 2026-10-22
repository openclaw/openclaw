import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";
import { firstMockArg } from "../test-support/mock-calls.js";
export { firstMockArg, firstMockCall } from "../test-support/mock-calls.js";
import {
  createAutomaticSourceDeliveryContext,
  createBaseContext,
  createDiscordDraftStream,
  createMockDraftStream,
  deliverDiscordReply,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  runProcessDiscordMessage,
  sendMocksForTest as sendMocks,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";

type AutomaticSourceDeliveryOverrides = Parameters<typeof createAutomaticSourceDeliveryContext>[0];

export async function runBase(overrides: Parameters<typeof createBaseContext>[0] = {}) {
  await runProcessDiscordMessage(await createBaseContext(overrides));
}

export async function sendFinal(
  params: DispatchInboundParams | undefined,
  payload: Parameters<DispatchInboundParams["dispatcher"]["sendFinalReply"]>[0],
  wait = true,
) {
  await params?.dispatcher.sendFinalReply(payload);
  if (wait) {
    await params?.dispatcher.waitForIdle();
  }
  return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
}

export async function createAutomaticDraftContext(
  overrides: AutomaticSourceDeliveryOverrides = {},
): Promise<Awaited<ReturnType<typeof createAutomaticSourceDeliveryContext>>> {
  // Draft tests own preview behavior; keep reaction timers out of their fake-clock lifecycle.
  return await createAutomaticSourceDeliveryContext(overrides, { disableStatusReactions: true });
}

export function getReactionEmojis(): string[] {
  return (
    sendMocks.reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
  ).map((call) => call[2]);
}

export const requireRecord = createRequireRecord("object", "label-not-object");

export function firstDispatchParams(): DispatchInboundParams {
  return firstMockArg(dispatchInboundMessage, "dispatchInboundMessage") as DispatchInboundParams;
}

export function expectRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, unknown>,
) {
  expect(Object.fromEntries(Object.keys(fields).map((key) => [key, record[key]]))).toEqual(fields);
}

export function expectReactAckCallAt(
  index: number,
  emoji: string,
  params?: {
    accountId?: string;
    ackReaction?: string;
    channelId?: string;
    messageId?: string;
  },
) {
  const call = sendMocks.reactMessageDiscord.mock.calls[index];
  expect(call?.slice(0, 3)).toEqual([
    params?.channelId ?? "c1",
    params?.messageId ?? "1001",
    emoji,
  ]);
  const options = requireRecord(call?.[3], "reaction runtime options");
  requireRecord(options.rest, "reaction REST client");
  if (params?.accountId) {
    expect(options.accountId).toBe(params.accountId);
  }
  if (params?.ackReaction) {
    const cfg = requireRecord(options.cfg, "reaction config");
    expect(requireRecord(cfg.messages, "reaction message config").ackReaction).toEqual(
      params.ackReaction,
    );
  }
}

export function expectReactionCallsContain(channelId: string, messageId: string, emoji: string) {
  expect(sendMocks.reactMessageDiscord.mock.calls.map((call) => call.slice(0, 3))).toContainEqual([
    channelId,
    messageId,
    emoji,
  ]);
}

export function createMockDraftStreamForTest() {
  const draftStream = createMockDraftStream();
  createDiscordDraftStream.mockReturnValueOnce(draftStream);
  return draftStream;
}

export function getDeliveredFinalTexts(): string[] {
  return deliverDiscordReply.mock.calls.flatMap((call) => {
    const params = requireRecord(call[0], "deliverDiscordReply params");
    if (params.kind !== "final") {
      return [];
    }
    return ((params as { replies?: Array<{ text?: string }> }).replies ?? []).flatMap((reply) =>
      typeof reply.text === "string" ? [reply.text] : [],
    );
  });
}

export function expectFreshFinalText(text: string) {
  const firstFinal = deliverDiscordReply.mock.calls
    .map((call) => requireRecord(call[0], "deliverDiscordReply params"))
    .find((params) => params.kind === "final");
  expect(firstFinal).toBeDefined();
  const replies = (firstFinal as { replies?: Array<{ text?: string }> }).replies;
  expect(replies?.[0]?.text).toBe(text);
}

type DispatchResult = Awaited<ReturnType<typeof dispatchInboundMessage>>;
export function mockDispatch(
  run: (params: DispatchInboundParams | undefined) => Promise<DispatchResult | void>,
) {
  dispatchInboundMessage.mockImplementationOnce(
    async (params) =>
      (await run(params)) ?? { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } },
  );
}

export function useProgressDraftStartDelay() {
  vi.useFakeTimers();
  return async () => {
    // Mirrors core's DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS.
    await vi.advanceTimersByTimeAsync(1_500);
  };
}

export async function runSingleChunkFinalScenario(discordConfig: Record<string, unknown>) {
  dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
    await params?.dispatcher.sendFinalReply({ text: "Hello\nWorld" });
    return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
  });

  await runProcessDiscordMessage(await createAutomaticDraftContext({ discordConfig }));
}

export async function createBlockModeContext() {
  return await createAutomaticDraftContext({
    cfg: {
      messages: { ackReaction: "👀" },
      session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      channels: {
        discord: {
          streaming: {
            preview: { chunk: { minChars: 1, maxChars: 5, breakPreference: "newline" } },
          },
        },
      },
    },
    discordConfig: { streaming: { mode: "block" } },
  });
}
