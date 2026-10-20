import type { OpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";
import type { QaTransportAdapter } from "./qa-transport.js";

export type CrablineTransport = Awaited<ReturnType<typeof createQaCrablineTransportAdapter>>;

export function createSelection(
  channel: OpenClawCrablineChannelDriverSelection["channel"] = "telegram",
) {
  return {
    capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
    channel,
    channelDriver: "crabline",
    providerReadinessArtifactPath: "crabline-provider-readiness.json",
  } as const;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

export function telegramApi(transport: Pick<QaTransportAdapter, "createGatewayConfig">) {
  const telegram = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" }).channels
    ?.telegram;
  const url = `${requireString(telegram?.apiRoot, "Telegram API root")}/bot${requireString(telegram?.botToken, "Telegram bot token")}`;
  const post = async (method: string, body: Record<string, unknown>, status = 200) => {
    const payload = await postJson(`${url}/${method}`, body, "qa-lab-crabline-telegram-test", {
      status,
    });
    expect(payload).toMatchObject({ ok: status === 200 });
    return payload;
  };
  const send = async (chatId: string, threadId: string, text: string) => {
    const payload = await post("sendMessage", {
      chat_id: chatId,
      message_thread_id: Number(threadId),
      text,
    });
    if (
      !isRecord(payload) ||
      !isRecord(payload.result) ||
      typeof payload.result.message_id !== "number"
    ) {
      throw new Error("Crabline Telegram send did not return a message ID");
    }
    return payload.result.message_id;
  };
  return { url, post, send };
}

export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  auditContext: string,
  init: { method?: string; headers?: Record<string, string>; status?: number } = {},
): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: init.method ?? "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...init.headers },
    },
    policy: { allowPrivateNetwork: true },
    auditContext,
  });
  try {
    if (init.status === undefined) {
      expect(response.ok).toBe(true);
    } else {
      expect(response.status).toBe(init.status);
    }
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

export async function withTransport(
  channel: OpenClawCrablineChannelDriverSelection["channel"],
  run: (transport: CrablineTransport, outputDir: string) => Promise<void>,
  transportPolicy?: Parameters<typeof createQaCrablineTransportAdapter>[0]["transportPolicy"],
) {
  await withTempDir("qa-crabline-transport-", async (outputDir) => {
    const transport = await createQaCrablineTransportAdapter({
      outputDir,
      selection: createSelection(channel),
      state: createQaBusState(),
      transportPolicy,
    });
    try {
      await run(transport, outputDir);
    } finally {
      await transport.cleanupAfterGatewayStop();
    }
  });
}
