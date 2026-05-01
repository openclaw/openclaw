import { WebSocket } from "ws";

const PROTOCOL_VERSION = 3;

const url = process.env.GW_URL;
const token = process.env.GW_TOKEN;
if (!url || !token) {
  throw new Error("missing GW_URL/GW_TOKEN");
}

const CONNECT_READY_TIMEOUT_MS = Number.parseInt(
  process.env.OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS || "60000",
  10,
);

async function openSocket() {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 30_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return ws;
}

function onceFrame(ws, filter, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const handler = (data) => {
      const obj = JSON.parse(String(data));
      if (!filter(obj)) {
        return;
      }
      clearTimeout(timer);
      ws.off("message", handler);
      resolve(obj);
    };
    ws.on("message", handler);
  });
}

async function attemptConnect() {
  const ws = await openSocket();
  ws.send(
    JSON.stringify({
      type: "req",
      id: "c1",
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "test",
          displayName: "docker-net-e2e",
          version: "dev",
          platform: process.platform,
          mode: "test",
        },
        caps: [],
        auth: { token },
      },
    }),
  );

  const connectRes = await onceFrame(ws, (frame) => frame?.type === "res" && frame?.id === "c1");
  if (connectRes.ok) {
    ws.close();
    return;
  }
  ws.close();
  throw new Error(`connect failed: ${connectRes.error?.message ?? "unknown"}`);
}

const startedAt = Date.now();
let lastError;
while (Date.now() - startedAt < CONNECT_READY_TIMEOUT_MS) {
  try {
    await attemptConnect();
    console.log("ok");
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (!String(error).includes("gateway starting")) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

throw lastError ?? new Error("connect failed");
