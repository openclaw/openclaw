import type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/setup";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";

export type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
export type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/setup";

export type BlueBubblesGroupConfig = {
  /** If true, only respond in this group when mentioned. */
  requireMention?: boolean;
  /** Optional tool policy overrides for this group. */
  tools?: { allow?: string[]; deny?: string[] };
};

export type BlueBubblesActionConfig = {
  reactions?: boolean;
  edit?: boolean;
  unsend?: boolean;
  reply?: boolean;
  sendWithEffect?: boolean;
  renameGroup?: boolean;
  setGroupIcon?: boolean;
  addParticipant?: boolean;
  removeParticipant?: boolean;
  leaveGroup?: boolean;
  sendAttachment?: boolean;
};

export type BlueBubblesNetworkConfig = {
  /** Dangerous opt-in for same-host or trusted private/internal BlueBubbles deployments. */
  dangerouslyAllowPrivateNetwork?: boolean;
};

export const BLUEBUBBLES_SEND_METHODS = ["apple-script", "private-api"] as const;
export type BlueBubblesSendMethod = (typeof BLUEBUBBLES_SEND_METHODS)[number];

export function normalizeBlueBubblesSendMethod(
  raw?: string | null,
): BlueBubblesSendMethod | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  return normalized === "apple-script" || normalized === "private-api" ? normalized : undefined;
}

export type BlueBubblesAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this BlueBubbles account. Default: true. */
  enabled?: boolean;
  /** Base URL for the BlueBubbles API. */
  serverUrl?: string;
  /** Password for BlueBubbles API authentication. */
  password?: string;
  /** Webhook path for the gateway HTTP server. */
  webhookPath?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  /** Optional allowlist for group senders. */
  groupAllowFrom?: Array<string | number>;
  /** Group message handling policy. */
  groupPolicy?: GroupPolicy;
  /** Enrich unnamed group participants with local macOS Contacts names after gating. Default: true. */
  enrichGroupParticipantsFromContacts?: boolean;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, unknown>;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "newline" (default) splits on every newline; "length" splits by size. */
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: Record<string, unknown>;
  /** Max outbound media size in MB. */
  mediaMaxMb?: number;
  /**
   * Explicit allowlist of local directory roots permitted for outbound media paths.
   * Local paths are rejected unless they resolve under one of these roots.
   */
  mediaLocalRoots?: string[];
  /** Force the BlueBubbles HTTP API send method for outbound delivery. */
  sendMethod?: BlueBubblesSendMethod;
  /** Send read receipts for incoming messages (default: true). */
  sendReadReceipts?: boolean;
  /** Network policy overrides for same-host or trusted private/internal BlueBubbles deployments. */
  network?: BlueBubblesNetworkConfig;
  /** Per-group configuration keyed by chat GUID or identifier. */
  groups?: Record<string, BlueBubblesGroupConfig>;
  /** Per-action tool gating (default: true for all). */
  actions?: BlueBubblesActionConfig;
  /** Channel health monitor overrides for this channel/account. */
  healthMonitor?: {
    enabled?: boolean;
  };
};

export type BlueBubblesConfig = Omit<BlueBubblesAccountConfig, "actions"> & {
  /** Optional per-account BlueBubbles configuration (multi-account). */
  accounts?: Record<string, BlueBubblesAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
  /** Per-action tool gating (default: true for all). */
  actions?: BlueBubblesActionConfig;
};

export type BlueBubblesSendTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; address: string; service?: "imessage" | "sms" | "auto" };

export type BlueBubblesAttachment = {
  guid?: string;
  uti?: string;
  mimeType?: string;
  transferName?: string;
  totalBytes?: number;
  height?: number;
  width?: number;
  originalROWID?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export function normalizeBlueBubblesServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("BlueBubbles serverUrl is required");
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

export function buildBlueBubblesApiUrl(params: {
  baseUrl: string;
  path: string;
  password?: string;
}): string {
  const normalized = normalizeBlueBubblesServerUrl(params.baseUrl);
  const url = new URL(params.path, `${normalized}/`);
  if (params.password) {
    url.searchParams.set("password", params.password);
  }
  return url.toString();
}

// Overridable guard for testing; production code uses fetchWithSsrFGuard.
let _fetchGuard = fetchWithSsrFGuard;

/** @internal Replace the SSRF fetch guard in tests. */
export function _setFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  _fetchGuard = impl ?? fetchWithSsrFGuard;
}

type ResponseLike = Pick<Response, "arrayBuffer" | "json" | "text" | "headers" | "status">;

async function bufferResponseLikeBody(
  response: Partial<ResponseLike>,
): Promise<ArrayBuffer | null> {
  if (typeof response.arrayBuffer === "function") {
    return await response.arrayBuffer();
  }
  if (typeof response.text === "function") {
    return new TextEncoder().encode(await response.text()).buffer;
  }
  if (typeof response.json === "function") {
    return new TextEncoder().encode(JSON.stringify(await response.json())).buffer;
  }
  return null;
}

export async function blueBubblesFetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
): Promise<Response> {
  // Always route through the guarded fetch seam so channel/plugin runtime code
  // never uses raw fetch() directly. When no SSRF policy is provided, keep the
  // previous permissive behavior by skipping DNS pinning instead of implicitly
  // turning on private-network blocking for legacy callers.
  const { response, release } = await _fetchGuard(
    ssrfPolicy === undefined
      ? {
          url,
          init,
          timeoutMs,
          pinDns: false,
          auditContext: "bluebubbles-api",
        }
      : {
          url,
          init,
          timeoutMs,
          policy: ssrfPolicy,
          auditContext: "bluebubbles-api",
        },
  );
  const status = typeof response.status === "number" ? response.status : 200;
  // Null-body status codes per Fetch spec — Response constructor rejects a body for these.
  const isNullBody = status === 101 || status === 204 || status === 205 || status === 304;
  try {
    const bodyBytes = isNullBody ? null : await bufferResponseLikeBody(response);
    return new Response(bodyBytes, {
      status,
      headers: response.headers,
    });
  } finally {
    await release();
  }
}
