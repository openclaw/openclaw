import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const WS_URL = "ws://127.0.0.1:18789";
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";

const mode = process.argv[2] ?? "fill";
const sessionKey = process.argv[3] ?? `persist-${Date.now()}`;

let rid = 0;
const nid = () => `r-${++rid}`;

function waitFor(ws: WebSocket, fn: (m: any) => boolean, ms = 300000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off("message", h);
      reject(new Error("timeout"));
    }, ms);
    const h = (d: any) => {
      try {
        const m = JSON.parse(d.toString());
        if (fn(m)) {
          clearTimeout(t);
          ws.off("message", h);
          resolve(m);
        }
      } catch {
        // ignore
      }
    };
    ws.on("message", h);
  });
}

async function connect(): Promise<WebSocket> {
  const ws = new WebSocket(WS_URL);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  await waitFor(ws, (m) => m.event === "connect.challenge", 10000);
  const cid = nid();
  ws.send(
    JSON.stringify({
      type: "req",
      id: cid,
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: "cli", version: "1", platform: "node", mode: "cli" },
        role: "operator",
        scopes: ["operator.admin"],
        auth: { token: TOKEN },
        caps: [],
      },
    }),
  );
  await waitFor(ws, (m) => m.type === "res" && m.id === cid, 10000);
  return ws;
}

async function sendMsg(ws: WebSocket, text: string): Promise<void> {
  const id = nid();
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method: "chat.send",
      params: {
        sessionKey,
        message: text,
        idempotencyKey: randomUUID(),
      },
    }),
  );
  await waitFor(ws, (m) => m.type === "res" && m.id === id, 300000);
}

async function main() {
  if (!TOKEN) {
    throw new Error("Missing OPENCLAW_GATEWAY_TOKEN");
  }
  const ws = await connect();
  console.log(`mode=${mode} sessionKey=${sessionKey}`);

  if (mode === "fill") {
    const long = "系统设计文档，包含模块边界、数据契约、超时重试策略、幂等设计。".repeat(240);
    for (let i = 0; i < 8; i++) {
      const msg = `轮次${i + 1}: Stripe endpoint=/api/stripe/v${i + 1}, db=postgres_${i + 1}, port=${4100 + i}. ${long}`;
      await sendMsg(ws, msg);
      console.log(`fill ${i + 1}/8`);
      await new Promise((r) => setTimeout(r, 800));
    }
    console.log("fill done");
  } else if (mode === "query") {
    await sendMsg(ws, "回忆一下之前提到的 Stripe endpoint 是什么？");
    console.log("query sent");
    await new Promise((r) => setTimeout(r, 4000));
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }

  ws.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
