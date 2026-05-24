import type { BrokerOutboundRequestV1, BrokerReceiptV1 } from "openclaw/plugin-sdk/channel-broker";
import type { ResolvedChannelBrokerAccount } from "./types.js";

export type ChannelBrokerRuntime = {
  createRequestId?: () => string;
  fetch?: typeof fetch;
  sendOutboundRequest?: (params: {
    account: ResolvedChannelBrokerAccount;
    request: BrokerOutboundRequestV1;
    signal?: AbortSignal;
  }) => Promise<BrokerReceiptV1>;
};

let runtime: ChannelBrokerRuntime = {};

export function setChannelBrokerRuntime(next: ChannelBrokerRuntime): void {
  runtime = { ...runtime, ...next };
}

export function resetChannelBrokerRuntimeForTest(): void {
  runtime = {};
}

export function getChannelBrokerRuntime(): ChannelBrokerRuntime {
  return runtime;
}

export function createBrokerRequestId(): string {
  const custom = runtime.createRequestId?.();
  if (custom?.trim()) {
    return custom.trim();
  }
  return `broker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function requireBrokerBaseUrl(account: ResolvedChannelBrokerAccount): string {
  const baseUrl = account.baseUrl?.trim();
  if (!baseUrl) {
    throw new Error(
      `Channel broker provider ${account.providerId} is not configured (missing baseUrl).`,
    );
  }
  return baseUrl.replace(/\/+$/u, "");
}

function parseBrokerReceipt(value: unknown): BrokerReceiptV1 {
  if (!value || typeof value !== "object") {
    throw new Error("Channel broker provider returned a non-object receipt.");
  }
  return value as BrokerReceiptV1;
}

async function sendBrokerOutboundHttp(params: {
  account: ResolvedChannelBrokerAccount;
  request: BrokerOutboundRequestV1;
  signal?: AbortSignal;
}): Promise<BrokerReceiptV1> {
  const fetchImpl = runtime.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Channel broker outbound HTTP transport requires fetch.");
  }
  const response = await fetchImpl(`${requireBrokerBaseUrl(params.account)}/v1/outbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-broker-provider": params.account.providerId,
      ...(params.account.outboundToken
        ? { authorization: `Bearer ${params.account.outboundToken}` }
        : {}),
    },
    body: JSON.stringify(params.request),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Channel broker provider returned HTTP ${response.status}.`);
  }
  return parseBrokerReceipt(await response.json());
}

export async function sendBrokerOutboundRequest(params: {
  account: ResolvedChannelBrokerAccount;
  request: BrokerOutboundRequestV1;
  signal?: AbortSignal;
}): Promise<BrokerReceiptV1> {
  if (runtime.sendOutboundRequest) {
    return await runtime.sendOutboundRequest(params);
  }
  return await sendBrokerOutboundHttp(params);
}
