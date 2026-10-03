import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveThreadSessionKeys,
  type ResolvedAgentRoute,
} from "openclaw/plugin-sdk/routing";

function resolveWhatsAppGroupAccountThreadId(accountId: string): string {
  return `whatsapp-account-${normalizeAccountId(accountId)}`;
}

export function resolveWhatsAppGroupSessionKey(params: {
  sessionKey: string;
  accountId?: string | null;
}): string {
  const accountId = normalizeAccountId(params.accountId);
  if (accountId === DEFAULT_ACCOUNT_ID || !params.sessionKey.includes(":group:")) {
    return params.sessionKey;
  }
  return resolveThreadSessionKeys({
    baseSessionKey: params.sessionKey,
    threadId: resolveWhatsAppGroupAccountThreadId(accountId),
  }).sessionKey;
}

export function resolveWhatsAppGroupSessionRoute(route: ResolvedAgentRoute): ResolvedAgentRoute {
  const sessionKey = resolveWhatsAppGroupSessionKey(route);
  if (sessionKey === route.sessionKey) {
    return route;
  }
  return {
    ...route,
    sessionKey,
  };
}
