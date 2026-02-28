/**
 * NC Talk typing indicator support via HPB (High Performance Backend) WebSocket signaling.
 *
 * NC Talk typing indicators are signaling-only — there is no REST API for this.
 * This module connects to the HPB signaling server using a short-lived JWT obtained
 * from the NC Talk REST API and sends typing events while a run is active.
 *
 * Protocol flow:
 * 1. GET /ocs/v2.php/apps/spreed/api/v3/signaling/settings?token={roomToken}
 *    → receive HPB WebSocket URL + JWT (60s TTL)
 * 2. Connect WebSocket to {hpbUrl}/spreed
 * 3. hello handshake (v2.0 with JWT) → receive sessionid + resumeid
 * 4. Send typing=true — repeated externally by createTypingCallbacks keepalive loop
 * 5. On stop: send typing=false, close WebSocket
 * 6. JWT refresh: re-fetch every ~50s, use resumeid to resume session
 *
 * Usage with createTypingCallbacks:
 *   const mgr = createNcTalkTypingManager({ ... });
 *   const callbacks = createTypingCallbacks({
 *     start: () => mgr.sendTyping(),   // called on each keepalive tick
 *     stop: () => mgr.stop(),
 *     onStartError: (err) => logTypingFailure(..., err),
 *   });
 */

import WebSocket from "ws";

export type NcTalkTypingManagerParams = {
  /** Nextcloud base URL (e.g. https://cloud.example.com) */
  baseUrl: string;
  /** Nextcloud API user (for fetching JWT) */
  apiUser: string;
  /** Nextcloud API password */
  apiPassword: string;
  /** Room/conversation token to type in */
  roomToken: string;
  /**
   * Disable TLS certificate verification for HPB WebSocket connections.
   * Only use for self-hosted instances with self-signed certificates.
   * Default: false.
   */
  allowInsecureSsl?: boolean;
};

export type NcTalkTypingManager = {
  /** Send a typing=true pulse. Connects WebSocket on first call; reconnects if needed. */
  sendTyping: () => Promise<void>;
  /** Send typing=false and close the WebSocket connection. */
  stop: () => Promise<void>;
};

type HelloResult = {
  sessionId: string;
  resumeId: string;
};

const SIGNALING_PATH = "/spreed";
const JWT_REFRESH_INTERVAL_MS = 50_000; // Refresh 10s before 60s expiry
const CONNECT_TIMEOUT_MS = 8_000;
const HELLO_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 8_000;

async function fetchSignalingSettings(params: {
  baseUrl: string;
  apiUser: string;
  apiPassword: string;
  roomToken: string;
}): Promise<{ hpbUrl: string; ncBaseUrl: string; jwt: string }> {
  const { baseUrl, apiUser, apiPassword, roomToken } = params;
  const url =
    `${baseUrl.replace(/\/$/, "")}/ocs/v2.php/apps/spreed/api/v3/signaling/settings` +
    `?token=${encodeURIComponent(roomToken)}`;
  const creds = Buffer.from(`${apiUser}:${apiPassword}`).toString("base64");

  const controller = new AbortController();
  const fetchTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${creds}`,
        "OCS-APIRequest": "true",
        Accept: "application/json",
      },
    });
  } finally {
    clearTimeout(fetchTimer);
  }

  if (!res.ok) {
    throw new Error(`Signaling settings fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    ocs?: {
      data?: {
        server?: string;
        helloAuthParams?: { "2.0"?: { token?: string } };
      };
    };
  };

  const hpbUrl = data?.ocs?.data?.server;
  const jwt = data?.ocs?.data?.helloAuthParams?.["2.0"]?.token;

  if (!hpbUrl || !jwt) {
    throw new Error(`NC Talk signaling not available (signalingMode may not be 'external')`);
  }

  return { hpbUrl, ncBaseUrl: baseUrl, jwt };
}

function buildWsUrl(hpbUrl: string): string {
  return (
    hpbUrl
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://")
      .replace(/\/$/, "") + SIGNALING_PATH
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

async function connectWebSocket(wsUrl: string, allowInsecureSsl = false): Promise<WebSocket> {
  return withTimeout(
    new Promise<WebSocket>((resolve, reject) => {
      const opts = allowInsecureSsl ? { rejectUnauthorized: false } : {};
      const sock = new WebSocket(wsUrl, opts);
      sock.once("open", () => resolve(sock));
      sock.once("error", reject);
    }),
    CONNECT_TIMEOUT_MS,
    "WebSocket connect",
  );
}

async function doHello(params: {
  ws: WebSocket;
  ncBaseUrl: string;
  jwt: string;
  resumeId?: string;
}): Promise<HelloResult> {
  const { ws, ncBaseUrl, jwt, resumeId } = params;

  // Receive or skip welcome
  await withTimeout(
    new Promise<void>((resolve) => {
      ws.once("message", () => resolve());
      ws.once("error", () => resolve()); // continue even if welcome is missing
    }),
    CONNECT_TIMEOUT_MS,
    "WebSocket welcome",
  );

  const helloMsg: Record<string, unknown> = {
    id: "hello-1",
    type: "hello",
    hello: {
      version: "2.0",
      features: ["typing-v1"],
      auth: {
        url: ncBaseUrl.replace(/\/$/, "") + "/",
        params: { token: jwt },
      },
      ...(resumeId ? { resumeid: resumeId } : {}),
    },
  };
  ws.send(JSON.stringify(helloMsg));

  return withTimeout(
    new Promise<HelloResult>((resolve, reject) => {
      ws.once("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            type?: string;
            hello?: { sessionid?: string; resumeid?: string };
            error?: { code?: string; message?: string };
          };
          if (msg.type === "error") {
            reject(
              new Error(
                `Hello failed: ${msg.error?.code ?? "unknown"} — ${msg.error?.message ?? ""}`,
              ),
            );
          } else if (msg.type === "hello" && msg.hello?.sessionid) {
            resolve({
              sessionId: msg.hello.sessionid,
              resumeId: msg.hello.resumeid ?? "",
            });
          } else {
            reject(new Error(`Unexpected hello response: ${msg.type ?? "?"}`));
          }
        } catch (e) {
          reject(e as Error);
        }
      });
      ws.once("error", reject);
    }),
    HELLO_TIMEOUT_MS,
    "WebSocket hello",
  );
}

function sendTypingMessage(ws: WebSocket, roomToken: string, typing: boolean): void {
  ws.send(
    JSON.stringify({
      type: "message",
      message: {
        recipient: { type: "room", roomid: roomToken },
        data: {
          type: "chat",
          chat: { refresh: false, typing },
        },
      },
    }),
  );
}

export function createNcTalkTypingManager(params: NcTalkTypingManagerParams): NcTalkTypingManager {
  const { baseUrl, apiUser, apiPassword, roomToken, allowInsecureSsl = false } = params;

  let ws: WebSocket | null = null;
  let hello: HelloResult | null = null;
  let jwtRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let connecting = false;
  let currentJwt = "";

  function clearJwtTimer(): void {
    if (jwtRefreshTimer) {
      clearTimeout(jwtRefreshTimer);
      jwtRefreshTimer = null;
    }
  }

  async function refreshJwt(): Promise<void> {
    if (stopped || !ws || ws.readyState !== WebSocket.OPEN || !hello) return;
    try {
      const settings = await fetchSignalingSettings({ baseUrl, apiUser, apiPassword, roomToken });
      currentJwt = settings.jwt;
      // Resume session with new token
      const resumeMsg = {
        type: "hello",
        hello: {
          version: "2.0",
          auth: { url: baseUrl.replace(/\/$/, "") + "/", params: { token: currentJwt } },
          resumeid: hello.resumeId,
        },
      };
      ws.send(JSON.stringify(resumeMsg));
    } catch {
      // Non-fatal — next sendTyping will reconnect if needed
    }
    if (!stopped) {
      jwtRefreshTimer = setTimeout(() => {
        void refreshJwt();
      }, JWT_REFRESH_INTERVAL_MS);
    }
  }

  async function connect(): Promise<void> {
    const settings = await fetchSignalingSettings({ baseUrl, apiUser, apiPassword, roomToken });
    currentJwt = settings.jwt;
    const wsUrl = buildWsUrl(settings.hpbUrl);

    const sock = await connectWebSocket(wsUrl, allowInsecureSsl);
    sock.on("error", () => {
      if (ws === sock) ws = null;
    });
    sock.on("close", () => {
      if (ws === sock) ws = null;
    });

    const helloResult = await doHello({ ws: sock, ncBaseUrl: baseUrl, jwt: currentJwt });

    ws = sock;
    hello = helloResult;

    // Schedule JWT refresh before expiry
    clearJwtTimer();
    jwtRefreshTimer = setTimeout(() => {
      void refreshJwt();
    }, JWT_REFRESH_INTERVAL_MS);
  }

  const sendTyping = async (): Promise<void> => {
    if (stopped) return;

    // Connect or reconnect if needed — guard against concurrent connect() calls
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (connecting) return; // Another connect is in flight; skip this pulse
      connecting = true;
      try {
        hello = null;
        await connect();
      } finally {
        connecting = false;
      }
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      sendTypingMessage(ws, roomToken, true);
    }
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    clearJwtTimer();

    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        sendTypingMessage(ws, roomToken, false);
      } catch {
        // best-effort
      }
      ws.close();
    }
    ws = null;
    hello = null;
  };

  return { sendTyping, stop };
}
