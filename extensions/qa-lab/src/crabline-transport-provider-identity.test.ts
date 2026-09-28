import type { OpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

const selection = {
  capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
  channel: "telegram",
  channelDriver: "crabline",
  providerReadinessArtifactPath: "crabline-provider-readiness.json",
} as const satisfies OpenClawCrablineChannelDriverSelection;

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

async function readTelegramInbound(
  transport: Awaited<ReturnType<typeof createQaCrablineTransportAdapter>>,
) {
  const config = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
  const telegram = config.channels?.telegram as { apiRoot?: string; botToken?: string } | undefined;
  const apiRoot = requireString(telegram?.apiRoot, "Telegram API root");
  const botToken = requireString(telegram?.botToken, "Telegram bot token");
  const response = await fetch(`${apiRoot}/bot${botToken}/getUpdates`);
  const updates = (await response.json()) as {
    result?: Array<{ message?: { chat?: { id?: number }; message_thread_id?: number } }>;
  };
  return { apiRoot, botToken, message: updates.result?.at(-1)?.message };
}

async function postTelegramMessage(params: {
  apiRoot: string;
  body: Record<string, unknown>;
  botToken: string;
}) {
  const { response, release } = await fetchWithSsrFGuard({
    url: `${params.apiRoot}/bot${params.botToken}/sendMessage`,
    init: {
      body: JSON.stringify(params.body),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    policy: { allowPrivateNetwork: true },
    auditContext: "qa-lab-crabline-telegram-provider-correlation-test",
  });
  await release();
  expect(response.ok).toBe(true);
}

describe("Crabline Telegram provider identity", () => {
  it.each([
    {
      conversation: { id: "alice/team", kind: "direct" },
      senderId: "alice/team",
      threadId: "42",
    },
    {
      conversation: { id: "telegram-announcements", kind: "channel" },
      senderId: "alice",
      threadId: undefined,
    },
  ] as const)(
    "correlates $conversation.kind replies without delivery registration",
    async ({ conversation, senderId, threadId }) => {
      await withTempDir("qa-crabline-transport-", async (outputDir) => {
        const transport = await createQaCrablineTransportAdapter({
          outputDir,
          selection,
          state: createQaBusState(),
        });
        try {
          const inbound = await transport.sendInbound({
            conversation,
            senderId,
            text: "provider identity baseline",
            ...(threadId ? { threadId } : {}),
          });
          if (threadId) {
            expect(inbound).toMatchObject({ conversation, threadId });
          }

          const { apiRoot, botToken, message } = await readTelegramInbound(transport);
          expect(message?.chat?.id).toEqual(expect.any(Number));
          if (threadId) {
            expect(message?.message_thread_id).toEqual(expect.any(Number));
          }
          await postTelegramMessage({
            apiRoot,
            botToken,
            body: {
              chat_id: message?.chat?.id,
              ...(message?.message_thread_id
                ? { message_thread_id: message.message_thread_id }
                : {}),
              text: "provider reply",
            },
          });

          await expect(
            transport.waitForOutbound({
              conversation,
              textIncludes: "provider reply",
              ...(threadId ? { threadId } : {}),
              timeoutMs: 1_000,
            }),
          ).resolves.toMatchObject({
            conversation,
            text: "provider reply",
            ...(threadId ? { threadId } : {}),
          });
        } finally {
          await transport.cleanupAfterGatewayStop();
        }
      });
    },
  );
});
