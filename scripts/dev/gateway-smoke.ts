import { randomUUID } from "node:crypto";
import WebSocket from "ws";

type GatewayReqFrame = { type: "req"; id: string; method: string; params?: unknown };
type GatewayResFrame = { type: "res"; id: string; ok: boolean; payload?: unknown; error?: unknown };
type GatewayEventFrame = { type: "event"; event: string; seq?: number; payload?: unknown };
type GatewayFrame = GatewayReqFrame | GatewayResFrame | GatewayEventFrame | { type: string };

const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
};

const urlRaw = getArg("--url") ?? process.env.OPENCLAW_GATEWAY_URL;
const token = getArg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN;

if (!urlRaw || !token) {
  // eslint-disable-next-line no-console
  console.error(
    "Usage: bun scripts/dev/gateway-smoke.ts --url <wss://host[:port]> --token <gateway.auth.token>\n" +
      "Or set env: OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN",
  );
  process.exit(1);
}

const url = new URL(urlRaw.includes("://") ? urlRaw : `wss://${urlRaw}`);
if (!url.port) {
  url.port = url.protocol === "wss:" ? "443" : "80";
}

const randomId = () => randomUUID();

async function main() {
  const ws = new WebSocket(url.toString(), { handshakeTimeout: 8000 });
  const pending = new Map<
    string,
    {
      resolve: (res: GatewayResFrame) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  const request = (method: string, params?: unknown, timeoutMs = 12000) =>
    new Promise<GatewayResFrame>((resolve, reject) => {
      const id = randomId();
      const frame: GatewayReqFrame = { type: "req", id, method, params };
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify(frame));
    });

  const waitOpen = () =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws open timeout")), 8000);
      ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

  const toText = (data: WebSocket.RawData) => {
    if (typeof data === "string") {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString("utf8");
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8");
    }
    return Buffer.from(data as Buffer).toString("utf8");
  };

  ws.on("message", (data) => {
    const text = toText(data);
    let frame: GatewayFrame | null = null;
    try {
      frame = JSON.parse(text) as GatewayFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object" || !("type" in frame)) {
      return;
    }
    if (frame.type === "res") {
      const res = frame as GatewayResFrame;
      const waiter = pending.get(res.id);
      if (waiter) {
        pending.delete(res.id);
        clearTimeout(waiter.timeout);
        waiter.resolve(res);
      }
      return;
    }
    if (frame.type === "event") {
      const evt = frame as GatewayEventFrame;
      if (evt.event === "connect.challenge") {
        return;
      }
      return;
    }
  });

  await waitOpen();

  // Match iOS "operator" session defaults: token auth, no device identity.
  const connectRes = await request("connect", {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "openclaw-ios",
      displayName: "openclaw gateway smoke test",
      version: "dev",
      platform: "dev",
      mode: "ui",
      instanceId: "openclaw-dev-smoke",
    },
    locale: "en-US",
    userAgent: "gateway-smoke",
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: [],
    auth: { token },
  });

  if (!connectRes.ok) {
    // eslint-disable-next-line no-console
    console.error("connect failed:", connectRes.error);
    process.exit(2);
  }

  const healthRes = await request("health");
  if (!healthRes.ok) {
    // eslint-disable-next-line no-console
    console.error("health failed:", healthRes.error);
    process.exit(3);
  }

  const historyRes = await request("chat.history", { sessionKey: "main" }, 15000);
  if (!historyRes.ok) {
    // eslint-disable-next-line no-console
    console.error("chat.history failed:", historyRes.error);
    process.exit(4);
  }

  // eslint-disable-next-line no-console
  console.log("ok: connected + health + chat.history");
  ws.close();
}

await main();
