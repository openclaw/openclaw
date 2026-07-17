import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
  GatewayBrowserDeviceAuthLifecycle,
  GatewayProtocolClient,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  ed25519Utils,
  getPublicKeyAsync,
  signAsync,
} from "./copilot-runtime.js";

const CLIENT_ID = GATEWAY_CLIENT_IDS.BROWSER_COPILOT;
const CLIENT_MODE = GATEWAY_CLIENT_MODES.UI;
const ROLE = "operator";
const SCOPES = ["operator.read", "operator.write"];
const IDENTITY_KEY = "copilotDeviceIdentityV1";
const TOKENS_KEY = "copilotDeviceTokensV1";

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadOrCreateIdentity(storage) {
  const stored = (await storage.get([IDENTITY_KEY]))[IDENTITY_KEY];
  if (
    typeof stored?.deviceId === "string" &&
    typeof stored?.publicKey === "string" &&
    typeof stored?.secretKey === "string"
  ) {
    const secretKey = fromBase64Url(stored.secretKey);
    return {
      deviceId: stored.deviceId,
      publicKey: stored.publicKey,
      sign: async (payload) =>
        toBase64Url(await signAsync(new TextEncoder().encode(payload), secretKey)),
    };
  }
  const secretKey = ed25519Utils.randomSecretKey();
  const publicKeyBytes = await getPublicKeyAsync(secretKey);
  const identity = {
    deviceId: await sha256Hex(publicKeyBytes),
    publicKey: toBase64Url(publicKeyBytes),
    secretKey: toBase64Url(secretKey),
  };
  await storage.set({ [IDENTITY_KEY]: identity });
  return {
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    sign: async (payload) =>
      toBase64Url(await signAsync(new TextEncoder().encode(payload), secretKey)),
  };
}

function tokenKey({ clientId, deviceId, role }) {
  return `${clientId}:${deviceId}:${role}`;
}

function createTokenStore(storage) {
  return {
    async load(params) {
      const tokens = (await storage.get([TOKENS_KEY]))[TOKENS_KEY];
      const record = tokens?.[tokenKey(params)];
      return typeof record?.token === "string" && Array.isArray(record.scopes) ? record : null;
    },
    async store(params) {
      const current = (await storage.get([TOKENS_KEY]))[TOKENS_KEY];
      const tokens = current && typeof current === "object" ? { ...current } : {};
      tokens[tokenKey(params)] = { token: params.token, scopes: [...params.scopes] };
      await storage.set({ [TOKENS_KEY]: tokens });
    },
    async clear(params) {
      const current = (await storage.get([TOKENS_KEY]))[TOKENS_KEY];
      if (!current || typeof current !== "object") {
        return;
      }
      const tokens = { ...current };
      delete tokens[tokenKey(params)];
      await storage.set({ [TOKENS_KEY]: tokens });
    },
  };
}

function createBrowserSocket(url, handlers, WebSocketImpl) {
  const socket = new WebSocketImpl(url);
  socket.addEventListener("open", handlers.open);
  socket.addEventListener("message", (event) => handlers.message(String(event.data)));
  socket.addEventListener("close", (event) => handlers.close(event.code, event.reason));
  socket.addEventListener("error", () => handlers.error(new Error("Gateway WebSocket error")));
  return {
    isOpen: () => socket.readyState === WebSocketImpl.OPEN,
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
}

/** Dedicated browser-copilot Gateway client. It never accepts or stores shared auth. */
export class CopilotGatewayClient {
  constructor({ storage = chrome.storage.local, WebSocketImpl = WebSocket } = {}) {
    this.storage = storage;
    this.WebSocketImpl = WebSocketImpl;
    this.protocol = null;
    this.url = null;
    this.ready = false;
    this.hello = null;
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.lifecycle = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: () => loadOrCreateIdentity(this.storage),
      tokenStore: createTokenStore(this.storage),
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  start(url) {
    if (this.protocol && this.url === url) {
      return;
    }
    this.stop();
    this.url = url;
    this.#emitStatus({ state: "connecting", label: "Connecting to Gateway" });
    this.protocol = new GatewayProtocolClient({
      createSocket: (handlers) => createBrowserSocket(url, handlers, this.WebSocketImpl),
      createRequestId: () => crypto.randomUUID(),
      buildConnectPlan: ({ nonce }) =>
        this.lifecycle.buildPlan({
          client: {
            id: CLIENT_ID,
            version: chrome.runtime.getManifest().version,
            platform: "chrome",
            deviceFamily: "extension",
            mode: CLIENT_MODE,
          },
          role: ROLE,
          defaultScopes: SCOPES,
          nonce,
        }),
      buildConnectParams: (plan) => ({
        minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: CLIENT_ID,
          version: chrome.runtime.getManifest().version,
          platform: "chrome",
          deviceFamily: "extension",
          mode: CLIENT_MODE,
        },
        role: ROLE,
        scopes: plan.scopes,
        caps: [GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        auth: plan.auth,
        device: plan.device,
        userAgent: navigator.userAgent,
        locale: navigator.language,
      }),
      onConnectHello: (hello, { plan }) => {
        void this.lifecycle.acceptHello(hello, plan);
      },
      onHello: (hello) => {
        this.ready = true;
        this.hello = hello;
        this.#emitStatus({ state: "ready", label: "Gateway connected", hello });
      },
      onConnectFailure: (error, { plan }) => {
        const details = error.details && typeof error.details === "object" ? error.details : {};
        if (details.code === "AUTH_DEVICE_TOKEN_MISMATCH") {
          void this.lifecycle.clearStoredToken(plan);
        }
        this.#emitStatus({
          state: details.code === "PAIRING_REQUIRED" ? "approval" : "error",
          label: error.message,
          requestId: typeof details.requestId === "string" ? details.requestId : undefined,
        });
        return {
          closeCode: 4008,
          closeReason: "connect failed",
          reconnectDelayMs: details.code === "PAIRING_REQUIRED" ? 2_000 : undefined,
          stop: details.pauseReconnect === true,
        };
      },
      resolveClose: (context) => ({
        retry: context.connectFailure?.error?.details?.pauseReconnect !== true,
        notify: true,
        pendingError: context.connectFailure?.error,
      }),
      onClose: (_context, decision) => {
        this.ready = false;
        this.hello = null;
        if (decision.notify) {
          this.#emitStatus({ state: "connecting", label: "Gateway reconnecting" });
        }
      },
      onConnectError: (error) =>
        this.#emitStatus({ state: "error", label: error.message || "Gateway unavailable" }),
      onEvent: (event) => {
        for (const listener of this.listeners) {
          listener(event);
        }
      },
      handshake: { mode: "require-challenge", timeoutMs: 5_000 },
      reconnect: { initialMs: 1_000, multiplier: 2, maxMs: 30_000 },
      requestTimeoutMs: 30_000,
    });
    this.protocol.start();
  }

  stop() {
    this.ready = false;
    this.hello = null;
    this.protocol?.stop();
    this.protocol = null;
    this.url = null;
  }

  request(method, params, options) {
    if (!this.ready || !this.protocol) {
      return Promise.reject(new Error("Gateway is not ready"));
    }
    return this.protocol.request(method, params, options);
  }

  #emitStatus(status) {
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}
