import { loadOrCreateDeviceIdentity, signDevicePayload } from "./device-identity";
import { clearDeviceAuthToken, loadDeviceAuthToken, storeDeviceAuthToken } from "./device-auth";

type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
};

type HelloOk = {
  protocol: number;
  auth?: {
    deviceToken?: string;
    role?: string;
    scopes?: string[];
  };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

export type GatewayClientOptions = {
  url: string;
  token?: string;
  onHello?: (hello: HelloOk) => void;
  onEvent?: (evt: EventFrame) => void;
  onClose?: () => void;
};

function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  let h = "";
  for (const v of b) h += v.toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function buildDeviceAuthPayload(p: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce?: string | null;
}): string {
  const version = p.nonce ? "v2" : "v1";
  const base = [
    version,
    p.deviceId,
    p.clientId,
    p.clientMode,
    p.role,
    p.scopes.join(","),
    String(p.signedAtMs),
    p.token ?? "",
  ];
  if (version === "v2") base.push(p.nonce ?? "");
  return base.join("|");
}

const CONNECT_FAILED_CODE = 4008;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: number | null = null;
  private backoffMs = 800;

  private opts: GatewayClientOptions;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    for (const [, p] of this.pending) p.reject(new Error("stopped"));
    this.pending.clear();
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected"));
    }
    const id = uuid();
    const frame = { type: "req", id, method, params };
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
    });
    this.ws.send(JSON.stringify(frame));
    return p;
  }

  private connect() {
    if (this.closed) return;
    this.ws = new WebSocket(this.opts.url);
    this.ws.onopen = () => this.queueConnect();
    this.ws.onmessage = (ev) => this.handleMessage(String(ev.data ?? ""));
    this.ws.onclose = () => {
      this.ws = null;
      for (const [, p] of this.pending) p.reject(new Error("closed"));
      this.pending.clear();
      this.opts.onClose?.();
      this.scheduleReconnect();
    };
    this.ws.onerror = () => {};
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000);
    window.setTimeout(() => this.connect(), delay);
  }

  private queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer !== null) window.clearTimeout(this.connectTimer);
    this.connectTimer = window.setTimeout(() => void this.sendConnect(), 750);
  }

  private async sendConnect() {
    if (this.connectSent) return;
    this.connectSent = true;
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    const isSecure = typeof crypto !== "undefined" && !!crypto.subtle;
    const scopes = ["operator.admin", "operator.approvals", "operator.pairing"];
    const role = "operator";
    let deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null = null;
    let authToken = this.opts.token;
    let canFallback = false;

    if (isSecure) {
      deviceIdentity = await loadOrCreateDeviceIdentity();
      const stored = loadDeviceAuthToken({ deviceId: deviceIdentity.deviceId, role })?.token;
      authToken = stored ?? this.opts.token;
      canFallback = Boolean(stored && this.opts.token);
    }

    const auth = authToken ? { token: authToken } : undefined;

    let device: {
      id: string;
      publicKey: string;
      signature: string;
      signedAt: number;
      nonce: string | undefined;
    } | undefined;

    if (isSecure && deviceIdentity) {
      const signedAtMs = Date.now();
      const nonce = this.connectNonce ?? undefined;
      const payload = buildDeviceAuthPayload({
        deviceId: deviceIdentity.deviceId,
        clientId: "webchat-ui",
        clientMode: "webchat",
        role,
        scopes,
        signedAtMs,
        token: authToken ?? null,
        nonce,
      });
      const signature = await signDevicePayload(deviceIdentity.privateKey, payload);
      device = {
        id: deviceIdentity.deviceId,
        publicKey: deviceIdentity.publicKey,
        signature,
        signedAt: signedAtMs,
        nonce,
      };
    }

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "webchat-ui",
        version: "dev",
        platform: navigator.platform ?? "web",
        mode: "webchat",
      },
      role,
      scopes,
      device,
      caps: [],
      auth,
      userAgent: navigator.userAgent,
      locale: navigator.language,
    };

    void this.request<HelloOk>("connect", params)
      .then((hello) => {
        if (hello?.auth?.deviceToken && deviceIdentity) {
          storeDeviceAuthToken({
            deviceId: deviceIdentity.deviceId,
            role: hello.auth.role ?? role,
            token: hello.auth.deviceToken,
            scopes: hello.auth.scopes ?? [],
          });
        }
        this.backoffMs = 800;
        this.opts.onHello?.(hello);
      })
      .catch(() => {
        if (canFallback && deviceIdentity) {
          clearDeviceAuthToken({ deviceId: deviceIdentity.deviceId, role });
        }
        this.ws?.close(CONNECT_FAILED_CODE, "connect failed");
      });
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: unknown };

    if (frame.type === "event") {
      const evt = parsed as EventFrame;
      if (evt.event === "connect.challenge") {
        const p = evt.payload as { nonce?: unknown } | undefined;
        const nonce = p && typeof p.nonce === "string" ? p.nonce : null;
        if (nonce) {
          this.connectNonce = nonce;
          void this.sendConnect();
        }
        return;
      }
      this.opts.onEvent?.(evt);
      return;
    }

    if (frame.type === "res") {
      const res = parsed as ResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) return;
      this.pending.delete(res.id);
      if (res.ok) pending.resolve(res.payload);
      else pending.reject(new Error(res.error?.message ?? "request failed"));
    }
  }
}
