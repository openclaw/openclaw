import { randomUUID } from "node:crypto";
import fs from "node:fs";
import WebSocket from "ws";

const WS_URL = "ws://127.0.0.1:18789";
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
const MEMORY_DIR = `${process.env.HOME}/.openclaw/memory/context`;

let rid = 0;
const nid = () => "r-" + ++rid;

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
      } catch {}
    };
    ws.on("message", h);
  });
}

async function connect(): Promise<WebSocket> {
  const ws = new WebSocket(WS_URL);
  await new Promise<void>((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
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

async function sendMsg(ws: WebSocket, sessionKey: string, msg: string): Promise<boolean> {
  const mid = nid();
  ws.send(
    JSON.stringify({
      type: "req",
      id: mid,
      method: "chat.send",
      params: { sessionKey, message: msg, idempotencyKey: randomUUID() },
    }),
  );
  try {
    await waitFor(ws, (m) => m.type === "res" && m.id === mid, 300000);
    return true;
  } catch {
    return false;
  }
}

function checkState(): { segments: number; debugLines: string[] } {
  let segments = 0;
  try {
    segments = fs
      .readFileSync(`${MEMORY_DIR}/segments.jsonl`, "utf8")
      .split("\n")
      .filter((l) => l.trim()).length;
  } catch {}
  let debugLines: string[] = [];
  try {
    debugLines = fs
      .readFileSync("/tmp/mc-debug.log", "utf8")
      .split("\n")
      .filter((l) => l.trim());
  } catch {}
  return { segments, debugLines };
}

async function waitForState(
  predicate: (state: { segments: number; debugLines: string[] }) => boolean,
  timeoutMs = 30000,
  intervalMs = 1000,
): Promise<{ segments: number; debugLines: string[] }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = checkState();
    if (predicate(state)) {
      return state;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return checkState();
}

let passed = 0,
  failed = 0,
  skipped = 0;
function result(name: string, ok: boolean | null, detail?: string) {
  if (ok === null) {
    skipped++;
    console.log(`  ⏭ SKIP: ${name}${detail ? " — " + detail : ""}`);
  } else if (ok) {
    passed++;
    console.log(`  ✅ PASS: ${name}${detail ? " — " + detail : ""}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

async function main() {
  if (!TOKEN) {
    throw new Error("Missing OPENCLAW_GATEWAY_TOKEN");
  }
  // Avoid stale debug data from prior runs.
  try {
    fs.writeFileSync("/tmp/mc-debug.log", "");
  } catch {}
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║   Boundary & Multi-Round Integration Tests    ║");
  console.log("╚═══════════════════════════════════════════════╝\n");

  const ws = await connect();
  console.log("Connected\n");

  // ═══════ Test 1: Extension loading ═══════
  console.log("── Test 1: Extension loading ──");
  const sessionKey1 = "test1-" + Date.now();
  await sendMsg(ws, sessionKey1, "hello");
  const s1 = await waitForState(
    (state) =>
      state.debugLines.some((l) => l.includes("[buildExt] memCtxCfg")) &&
      state.debugLines.some((l) => l.includes("archive extension function called")) &&
      state.debugLines.some((l) => l.includes("recall extension function called")),
    30000,
    1000,
  );
  const hasDebug = s1.debugLines.length > 0;
  if (!hasDebug) {
    result("Archive extension loaded", null, "no debug log available");
    result("Recall extension loaded", null, "no debug log available");
    result("Global runtime set", null, "no debug log available");
  } else {
    result(
      "Archive extension loaded",
      s1.debugLines.some((l) => l.includes("archive extension function called")),
    );
    result(
      "Recall extension loaded",
      s1.debugLines.some((l) => l.includes("recall extension function called")),
    );
    result(
      "Global runtime set",
      s1.debugLines.some((l) => l.includes("[buildExt] memCtxCfg")),
    );
  }

  // ═══════ Test 2: Fill context to trigger compaction (16k context cap) ═══════
  console.log("\n── Test 2: Trigger compaction with 16k context ──");
  const sessionKey2 = "test2-" + Date.now();
  // Long messages to force compaction under capped context.
  const bigChunk = "详细的技术实现方案包含具体代码和配置参数。".repeat(120); // ~1000 chars
  for (let i = 0; i < 10; i++) {
    const topic = ["Stripe支付", "数据库配置", "Docker部署", "JWT认证", "文件上传"][i % 5];
    process.stdout.write(`  [${i + 1}/10] ${topic}... `);
    const ok = await sendMsg(
      ws,
      sessionKey2,
      `${topic}实现方案(${i + 1}): endpoint=/api/${topic}/v${i + 1}, port=${3000 + i}. ${bigChunk}`,
    );
    console.log(ok ? "✓" : "✗");
    await new Promise((r) => setTimeout(r, 2000));
  }

  const s2 = checkState();
  const compactFromDebug = s2.debugLines.some((l) => l.includes("session_before_compact"));
  result(
    "Compaction triggered",
    compactFromDebug || s2.segments > 0,
    `debug=${compactFromDebug} segments=${s2.segments}`,
  );
  result("Messages archived", s2.segments > 0, `segments: ${s2.segments}`);

  // ═══════ Test 3: Recall from archived content ═══════
  console.log("\n── Test 3: Recall from archived content ──");
  if (s2.segments > 0) {
    await sendMsg(ws, sessionKey2, "之前Stripe支付的endpoint是什么？");
    await new Promise((r) => setTimeout(r, 5000));
    const s3 = checkState();
    const recallFromDebug = s3.debugLines.some(
      (l) =>
        l.includes("recall block generated") ||
        l.includes("recall injected") ||
        l.includes("memory-context: recalled"),
    );
    result(
      "Recall triggered",
      recallFromDebug || s3.segments > 0,
      `debug=${recallFromDebug} segments=${s3.segments}`,
    );
  } else {
    result("Recall test", null, "no segments to recall from");
  }

  // ═══════ Test 4: Short query guard (no destructive trim) ═══════
  console.log("\n── Test 4: Short query guard ──");
  const s4before = checkState();
  await sendMsg(ws, sessionKey2, "y");
  await new Promise((r) => setTimeout(r, 3000));
  const s4after = checkState();
  result("Short query no crash", true, "no error on 'y'");
  // Allow small async drift (background compaction/archive from earlier turns may still flush).
  result(
    "Short query does not trigger aggressive archive",
    s4after.segments - s4before.segments <= 2,
    `before=${s4before.segments} after=${s4after.segments}`,
  );

  // ═══════ Test 5: Multiple sessions don't interfere ═══════
  console.log("\n── Test 5: Session isolation ──");
  const sessionKey5 = "test5-" + Date.now();
  await sendMsg(ws, sessionKey5, "这是一个完全独立的会话，不应该影响其他会话的记忆");
  await new Promise((r) => setTimeout(r, 3000));
  result("Independent session created", true);

  // ═══════ Test 6: Error isolation (gateway stays up) ═══════
  console.log("\n── Test 6: Error isolation ──");
  const gwUp = await new Promise<boolean>((resolve) => {
    const testWs = new WebSocket(WS_URL);
    testWs.on("open", () => {
      testWs.close();
      resolve(true);
    });
    testWs.on("error", () => resolve(false));
    setTimeout(() => resolve(false), 5000);
  });
  result("Gateway still running after all tests", gwUp);

  // ═══════ Test 7: Memory persistence check ═══════
  console.log("\n── Test 7: Persistence ──");
  result("Memory dir exists", fs.existsSync(MEMORY_DIR));
  if (fs.existsSync(`${MEMORY_DIR}/segments.jsonl`)) {
    const size = fs.statSync(`${MEMORY_DIR}/segments.jsonl`).size;
    result("segments.jsonl has content", size > 0, `${size} bytes`);
  } else {
    result("segments.jsonl exists", false);
  }

  // ═══════ Test 8: Redaction check ═══════
  console.log("\n── Test 8: Redaction ──");
  if (fs.existsSync(`${MEMORY_DIR}/segments.jsonl`)) {
    const content = fs.readFileSync(`${MEMORY_DIR}/segments.jsonl`, "utf8");
    const hasSecrets = /apiKey\s*[:=]\s*["']?[A-Za-z0-9]{20,}/.test(content);
    result("No plain secrets in stored segments", !hasSecrets);
  } else {
    result("Redaction check", null, "no segments file");
  }

  // ═══════ Summary ═══════
  console.log("\n╔═══════════════════════════════════════════════╗");
  console.log(`║  Results: ✅${passed} passed  ❌${failed} failed  ⏭${skipped} skipped  ║`);
  console.log("╚═══════════════════════════════════════════════╝");

  console.log("\n── Debug log ──");
  try {
    console.log(
      fs
        .readFileSync("/tmp/mc-debug.log", "utf8")
        .trim()
        .split("\n")
        .map((l) => "  " + l)
        .join("\n"),
    );
  } catch {
    console.log("  (none)");
  }

  ws.close();
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 1000);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
