import { randomUUID } from "node:crypto";
import WebSocket from "ws";

type GatewayReqFrame = { type: "req"; id: string; method: string; params?: unknown };
type GatewayResFrame = { type: "res"; id: string; ok: boolean; payload?: unknown; error?: unknown };
type GatewayEventFrame = { type: "event"; event: string; seq?: number; payload?: unknown };
type GatewayFrame = GatewayReqFrame | GatewayResFrame | GatewayEventFrame | { type: string };

type NodeListPayload = {
  ts?: number;
  nodes?: Array<{
    nodeId: string;
    displayName?: string;
    platform?: string;
    connected?: boolean;
    paired?: boolean;
    commands?: string[];
    permissions?: unknown;
  }>;
};

type NodeListNode = NonNullable<NodeListPayload["nodes"]>[number];

const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
};

const hasFlag = (flag: string) => args.includes(flag);

const urlRaw = getArg("--url") ?? process.env.OPENCLAW_GATEWAY_URL;
const token = getArg("--token") ?? process.env.OPENCLAW_GATEWAY_TOKEN;
const nodeHint = getArg("--node");
const dangerous = hasFlag("--dangerous") || process.env.OPENCLAW_RUN_DANGEROUS === "1";
const jsonOut = hasFlag("--json");

if (!urlRaw || !token) {
  // eslint-disable-next-line no-console
  console.error(
    "Usage: bun scripts/dev/ios-node-e2e.ts --url <wss://host[:port]> --token <gateway.auth.token> [--node <id|name-substring>] [--dangerous] [--json]\n" +
      "Or set env: OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN",
  );
  process.exit(1);
}

const url = new URL(urlRaw.includes("://") ? urlRaw : `wss://${urlRaw}`);
if (!url.port) {
  url.port = url.protocol === "wss:" ? "443" : "80";
}

const randomId = () => randomUUID();

const isoNow = () => new Date().toISOString();
const isoMinusMs = (ms: number) => new Date(Date.now() - ms).toISOString();

type TestCase = {
  id: string;
  command: string;
  params?: unknown;
  timeoutMs?: number;
  dangerous?: boolean;
};

function formatErr(err: unknown): string {
  if (!err) {
    return "error";
  }
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message || String(err);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

function pickIosNode(list: NodeListPayload, hint?: string): NodeListNode | null {
  const nodes = (list.nodes ?? []).filter((n) => n && n.connected);
  const ios = nodes.filter((n) => (n.platform ?? "").toLowerCase().includes("ios"));
  if (ios.length === 0) {
    return null;
  }
  if (!hint) {
    return ios[0] ?? null;
  }
  const h = hint.toLowerCase();
  return (
    ios.find((n) => n.nodeId.toLowerCase() === h) ??
    ios.find((n) => (n.displayName ?? "").toLowerCase().includes(h)) ??
    ios.find((n) => n.nodeId.toLowerCase().includes(h)) ??
    ios[0] ??
    null
  );
}

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

  const request = (method: string, params?: unknown, timeoutMs = 12_000) =>
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
      // Ignore; caller can extend to watch node.pair.* etc.
      return;
    }
  });

  await waitOpen();

  const connectRes = await request("connect", {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "cli",
      displayName: "openclaw ios node e2e",
      version: "dev",
      platform: "dev",
      mode: "cli",
      instanceId: "openclaw-dev-ios-node-e2e",
    },
    locale: "en-US",
    userAgent: "ios-node-e2e",
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

  const nodesRes = await request("node.list");
  if (!nodesRes.ok) {
    // eslint-disable-next-line no-console
    console.error("node.list failed:", nodesRes.error);
    process.exit(4);
  }

  const listPayload = (nodesRes.payload ?? {}) as NodeListPayload;
  let node = pickIosNode(listPayload, nodeHint);
  if (!node) {
    const waitSeconds = Number.parseInt(getArg("--wait-seconds") ?? "25", 10);
    const deadline = Date.now() + Math.max(1, waitSeconds) * 1000;
    while (!node && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await request("node.list").catch(() => null);
      if (!res?.ok) {
        continue;
      }
      node = pickIosNode((res.payload ?? {}) as NodeListPayload, nodeHint);
    }
  }
  if (!node) {
    // eslint-disable-next-line no-console
    console.error("No connected iOS nodes found. (Is the iOS app connected to the gateway?)");
    process.exit(5);
  }

  const tests: TestCase[] = [
    { id: "device.info", command: "device.info" },
    { id: "device.status", command: "device.status" },
    {
      id: "system.notify",
      command: "system.notify",
      params: { title: "OpenClaw E2E", body: `ios-node-e2e @ ${isoNow()}`, delivery: "system" },
    },
    {
      id: "contacts.search",
      command: "contacts.search",
      params: { query: null, limit: 5 },
    },
    {
      id: "calendar.events",
      command: "calendar.events",
      params: { startISO: isoMinusMs(6 * 60 * 60 * 1000), endISO: isoNow(), limit: 10 },
    },
    {
      id: "reminders.list",
      command: "reminders.list",
      params: { status: "incomplete", limit: 10 },
    },
    {
      id: "motion.pedometer",
      command: "motion.pedometer",
      params: { startISO: isoMinusMs(60 * 60 * 1000), endISO: isoNow() },
    },
    {
      id: "photos.latest",
      command: "photos.latest",
      params: { limit: 1, maxWidth: 512, quality: 0.7 },
    },
    {
      id: "camera.snap",
      command: "camera.snap",
      params: { facing: "back", maxWidth: 768, quality: 0.7, format: "jpeg" },
      dangerous: true,
      timeoutMs: 20_000,
    },
    {
      id: "screen.record",
      command: "screen.record",
      params: { durationMs: 2_000, fps: 15, includeAudio: false },
      dangerous: true,
      timeoutMs: 30_000,
    },
  ];

  const run = tests.filter((t) => dangerous || !t.dangerous);

  const results: Array<{
    id: string;
    ok: boolean;
    error?: unknown;
    payload?: unknown;
  }> = [];

  for (const t of run) {
    const invokeRes = await request(
      "node.invoke",
      {
        nodeId: node.nodeId,
        command: t.command,
        params: t.params,
        timeoutMs: t.timeoutMs ?? 12_000,
        idempotencyKey: randomUUID(),
      },
      (t.timeoutMs ?? 12_000) + 2_000,
    ).catch((err) => {
      results.push({ id: t.id, ok: false, error: formatErr(err) });
      return null;
    });

    if (!invokeRes) {
      continue;
    }

    if (!invokeRes.ok) {
      results.push({ id: t.id, ok: false, error: invokeRes.error });
      continue;
    }

    results.push({ id: t.id, ok: true, payload: invokeRes.payload });
  }

  if (jsonOut) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          gateway: url.toString(),
          node: {
            nodeId: node.nodeId,
            displayName: node.displayName,
            platform: node.platform,
          },
          dangerous,
          results,
        },
        null,
        2,
      ),
    );
  } else {
    const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
    const rows = results.map((r) => ({
      cmd: r.id,
      ok: r.ok ? "ok" : "fail",
      note: r.ok ? "" : formatErr(r.error ?? "error"),
    }));
    const width = Math.min(64, Math.max(12, ...rows.map((r) => r.cmd.length)));
    // eslint-disable-next-line no-console
    console.log(`node: ${node.displayName ?? node.nodeId} (${node.platform ?? "unknown"})`);
    // eslint-disable-next-line no-console
    console.log(`dangerous: ${dangerous ? "on" : "off"}`);
    // eslint-disable-next-line no-console
    console.log("");
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(`${pad(r.cmd, width)}  ${pad(r.ok, 4)}  ${r.note}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  ws.close();

  if (failed.length > 0) {
    process.exit(10);
  }
}

await main();
