import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;
type DispatchInboundFn = NonNullable<PluginRuntime["channel"]["dispatchInbound"]>;
const DEFAULT_SESSION_KEY_TEMPLATE = "agent:{agentId}:{channel}:{accountId}:dm:{openId}";
const DEFAULT_SESSION_KEY_MAX_LEN = 256;
const SESSION_KEY_TEMPLATE_TOKENS = ["{agentId}", "{channel}", "{accountId}", "{openId}"] as const;

export function setWempRuntime(next: PluginRuntime): void {
  if (!trySetWempRuntime(next)) {
    runtime = next;
  }
}

export function trySetWempRuntime(next: unknown): boolean {
  const candidate = next as any;
  if (
    candidate?.channel?.dispatchInbound &&
    typeof candidate.channel.dispatchInbound === "function"
  ) {
    runtime = candidate as PluginRuntime;
    return true;
  }
  if (candidate?.dispatchInbound && typeof candidate.dispatchInbound === "function") {
    runtime = {
      ...(candidate || {}),
      channel: {
        ...(candidate.channel || {}),
        dispatchInbound: candidate.dispatchInbound,
      },
    } as PluginRuntime;
    return true;
  }
  return false;
}

export function getWempRuntime(): PluginRuntime {
  if (!runtime) throw new Error("wemp runtime not initialized");
  return runtime;
}

export function clearWempRuntime(): void {
  runtime = null;
}

function resolveDispatchInbound(rt: PluginRuntime): DispatchInboundFn | null {
  const nested = rt.channel?.dispatchInbound;
  if (typeof nested === "function") {
    return nested;
  }
  const fallback = (rt as { dispatchInbound?: unknown }).dispatchInbound;
  if (typeof fallback === "function") {
    return fallback as DispatchInboundFn;
  }
  return null;
}

function normalizeChatType(raw: string | undefined): string {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (value === "direct" || value === "group") return value;
  return "direct";
}

function runtimeValidationEnabled(): boolean {
  return process.env.WEMP_RUNTIME_VALIDATE === "1";
}

function resolveSessionKeyTemplate(): string {
  return (
    String(process.env.WEMP_RUNTIME_SESSION_KEY_TEMPLATE || DEFAULT_SESSION_KEY_TEMPLATE).trim() ||
    DEFAULT_SESSION_KEY_TEMPLATE
  );
}

function resolveSessionKeyMaxLen(): number {
  const value = Number.parseInt(String(process.env.WEMP_RUNTIME_SESSION_KEY_MAX_LEN ?? ""), 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SESSION_KEY_MAX_LEN;
  return value;
}

function validateChatType(raw: string | undefined): string | null {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (!value) return null;
  if (value === "direct" || value === "group") return null;
  return `invalid runtime chatType: ${raw}`;
}

function validateSessionKeyTemplate(template: string): string | null {
  if (!template.trim()) return "invalid sessionKey template: empty";
  for (const token of SESSION_KEY_TEMPLATE_TOKENS) {
    if (!template.includes(token)) return `invalid sessionKey template: missing ${token}`;
  }
  return null;
}

function validateSessionKey(sessionKey: string): string | null {
  if (!sessionKey.trim()) return "invalid sessionKey: empty";
  if (/[\u0000-\u001f\u007f]/.test(sessionKey))
    return "invalid sessionKey: contains control characters";
  return null;
}

function buildSessionKey(params: {
  channel: string;
  accountId: string;
  openId: string;
  agentId: string;
  template: string;
}): string {
  return params.template
    .replaceAll("{agentId}", params.agentId)
    .replaceAll("{channel}", params.channel)
    .replaceAll("{accountId}", params.accountId)
    .replaceAll("{openId}", params.openId);
}

export async function dispatchToAgent(params: {
  channel: string;
  accountId: string;
  openId: string;
  agentId: string;
  text: string;
  messageId?: string;
}): Promise<{ accepted: boolean; sessionKey?: string; note?: string }> {
  const rt = getWempRuntime();
  const dispatch = resolveDispatchInbound(rt);
  if (typeof dispatch !== "function") {
    return { accepted: false, note: "runtime.channel.dispatchInbound unavailable" };
  }

  const validate = runtimeValidationEnabled();
  const chatTypeRaw = process.env.WEMP_RUNTIME_CHAT_TYPE;
  const sessionKeyTemplate = resolveSessionKeyTemplate();

  if (validate) {
    const chatTypeError = validateChatType(chatTypeRaw);
    if (chatTypeError) return { accepted: false, note: chatTypeError };
    const templateError = validateSessionKeyTemplate(sessionKeyTemplate);
    if (templateError) return { accepted: false, note: templateError };
  }

  const sessionKey = buildSessionKey({
    ...params,
    template: sessionKeyTemplate,
  });
  const maxSessionKeyLen = resolveSessionKeyMaxLen();
  if (sessionKey.length > maxSessionKeyLen) {
    return {
      accepted: false,
      note: `sessionKey length ${sessionKey.length} exceeds max ${maxSessionKeyLen}`,
    };
  }

  if (validate) {
    const sessionKeyError = validateSessionKey(sessionKey);
    if (sessionKeyError) return { accepted: false, note: sessionKeyError };
  }

  const chatType = normalizeChatType(chatTypeRaw);
  await dispatch({
    channel: params.channel,
    accountId: params.accountId,
    userId: params.openId,
    chatId: `${params.accountId}:${params.openId}`,
    chatType,
    sessionKey,
    text: params.text,
    messageId: params.messageId,
    targetAgentId: params.agentId,
  });
  return { accepted: true, sessionKey };
}
