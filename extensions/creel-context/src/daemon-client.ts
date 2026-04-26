// HTTP client for the creel daemon's local sender-classifier endpoints.
// The daemon binds 127.0.0.1:${DAEMON_PORT} so this client never reaches
// outside the agent pod. The daemon itself authenticates with the control
// plane on our behalf using its per-claw bearer token.

export type SenderResolution = {
  role: string;
  is_owner: boolean;
  user_id?: string;
  handle_display?: string;
  handle_status?: string;
  conversation_id?: string;
};

export type WhoamiQuery = {
  channel: string;
  handle: string;
  sessionKey?: string;
  groupKey?: string;
};

export type VerifyChannelTokenInput = {
  channel: string;
  handle: string;
  handleDisplay?: string;
  token: string;
};

export type VerifyChannelTokenResult = {
  handle_id: string;
  user_id: string;
  channel: string;
  handle_normalized: string;
  handle_display: string;
  status: string;
};

export type DaemonClientOptions = {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 1500;

export class DaemonClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DaemonClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/u, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // Resolves a (channel, handle) to its envelope. On any failure (timeout,
  // network, daemon down, control-plane down) we return the conservative
  // fail-closed answer (role=stranger) rather than throwing — the calling
  // hook must NEVER block the agent reply, so degraded mode beats hard fail.
  async whoami(query: WhoamiQuery): Promise<SenderResolution> {
    const url = new URL(`${this.baseUrl}/sender/whoami`);
    url.searchParams.set("channel", query.channel);
    url.searchParams.set("handle", query.handle);
    if (query.sessionKey) {
      url.searchParams.set("session_key", query.sessionKey);
    }
    if (query.groupKey) {
      url.searchParams.set("group_key", query.groupKey);
    }
    return this.requestJSON<SenderResolution>("GET", url.toString()).catch(() => ({
      role: "stranger",
      is_owner: false,
    }));
  }

  // Telegram /start <token> verification proxy. Returns the freshly created
  // OwnerChannelHandle on success; throws on failure so the caller can
  // distinguish "verification failed" from "control plane unreachable" and
  // surface the right operator-facing message.
  async verifyChannelToken(input: VerifyChannelTokenInput): Promise<VerifyChannelTokenResult> {
    return this.requestJSON<VerifyChannelTokenResult>(
      "POST",
      `${this.baseUrl}/verify-channel-token`,
      {
        channel: input.channel,
        handle: input.handle,
        handle_display: input.handleDisplay ?? "",
        token: input.token,
      },
    );
  }

  private async requestJSON<T>(
    method: "GET" | "POST",
    url: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        signal: controller.signal,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      };
      const resp = await this.fetchImpl(url, init);
      if (!resp.ok) {
        throw new Error(`daemon ${method} ${url} returned ${resp.status}`);
      }
      const text = await resp.text();
      if (!text) {
        return {} as T;
      }
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Resolves the daemon base URL from the runtime env. Returns null when
// neither override nor the env var is set so the plugin can degrade
// gracefully rather than fire requests at a nonsense URL.
export function resolveDaemonBaseUrl(override?: string): string | null {
  const trimmedOverride = override?.trim();
  if (trimmedOverride) {
    return trimmedOverride;
  }
  const port = process.env.DAEMON_PORT?.trim();
  if (!port) {
    return null;
  }
  return `http://127.0.0.1:${port}`;
}
