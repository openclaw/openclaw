function normalizeFeishuWebhookRateLimitClient(clientIp: string | undefined): string {
  if (!clientIp) {
    return "unknown";
  }
  if (clientIp === "::1" || clientIp.startsWith("127.")) {
    return "loopback";
  }
  return clientIp;
}

export function buildFeishuWebhookRateLimitKey(params: {
  accountId?: string;
  path: string;
  clientIp?: string;
}): string {
  const route = params.accountId === undefined ? params.path : `${params.accountId}:${params.path}`;
  return `${route}:${normalizeFeishuWebhookRateLimitClient(params.clientIp)}`;
}
