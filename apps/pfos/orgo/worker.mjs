import { hostname } from "node:os";
import { AGENT_PROFILES } from "./profiles.mjs";
import { buildContentDraft, buildMultiPlatformPack } from "./content-platforms.mjs";
import { resolveTradingAdapter } from "./trading-adapters.mjs";
import { publishToYouTube } from "./youtube-adapter.mjs";

const MAIN_URL = (process.env.PF_MAIN_URL ?? "http://127.0.0.1:18791").replace(/\/+$/, "");
const PROFILE = String(process.env.PF_WORKER_PROFILE ?? "main").toLowerCase();
const SELECTED_PROFILE =
  PROFILE === "youtube" || PROFILE === "yt"
    ? AGENT_PROFILES.youtube
    : PROFILE === "trading" || PROFILE === "trade"
      ? AGENT_PROFILES.trading
      : AGENT_PROFILES.main;
const WORKER_ID = process.env.PF_WORKER_ID ?? SELECTED_PROFILE.workerId;
const CAPS = (process.env.PF_WORKER_CAPS ?? SELECTED_PROFILE.capabilities.join(","))
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const HEARTBEAT_MS = Number.parseInt(process.env.PF_HEARTBEAT_MS ?? "10000", 10);
const POLL_MS = Number.parseInt(process.env.PF_POLL_MS ?? "3000", 10);
const API_TOKEN = String(process.env.PF_API_TOKEN ?? "").trim();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(path, body) {
  const headers = { "content-type": "application/json" };
  if (API_TOKEN) headers.authorization = `Bearer ${API_TOKEN}`;

  const res = await fetch(`${MAIN_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `request failed: ${path}`);
  }
  return data;
}

async function register() {
  await post("/register", {
    workerId: WORKER_ID,
    hostname: hostname(),
    capabilities: CAPS,
  });
}

async function heartbeat(status = "online") {
  await post("/heartbeat", { workerId: WORKER_ID, status });
}

async function executeTask(task) {
  const started = Date.now();
  const type = String(task.type ?? "").toLowerCase();
  const payload = task.payload ?? {};
  const timeoutMs = Number.isFinite(Number(task.timeoutMs)) ? Number(task.timeoutMs) : 60_000;
  const timeoutPromise = sleep(timeoutMs).then(() => {
    throw new Error(`task timed out after ${timeoutMs}ms`);
  });

  const workPromise = (async () => {
    await sleep(300 + Math.floor(Math.random() * 900));

    if (type.startsWith("yt.") || type.startsWith("youtube.") || type.startsWith("content.")) {
      if (type.startsWith("yt.publish") || type.startsWith("youtube.publish")) {
        const publishResult = await publishToYouTube(payload);
        return {
          workerId: WORKER_ID,
          taskType: task.type,
          mode: "youtube-publish",
          output: publishResult,
          elapsedMs: Date.now() - started,
        };
      }
      if (type.includes("pack") || payload.multiPlatform === true) {
        return {
          workerId: WORKER_ID,
          taskType: task.type,
          mode: "content-multi-platform",
          outputs: buildMultiPlatformPack(payload),
          elapsedMs: Date.now() - started,
        };
      }
      return {
        workerId: WORKER_ID,
        taskType: task.type,
        mode: "content-single-platform",
        output: buildContentDraft(payload),
        elapsedMs: Date.now() - started,
      };
    }

    if (type.startsWith("trade.") || type.startsWith("forex.") || type.startsWith("crypto.") || type.startsWith("market.")) {
      const adapter = resolveTradingAdapter(payload.provider);
      const tradingOutput =
        type.includes("backtest") || payload.action === "backtest"
          ? await adapter.runBacktest(payload)
          : await adapter.developStrategy(payload);
      return {
        workerId: WORKER_ID,
        taskType: task.type,
        mode: "trading-analysis",
        output: tradingOutput,
        elapsedMs: Date.now() - started,
      };
    }

    return {
      workerId: WORKER_ID,
      taskType: task.type,
      summary: `Executed ${task.type} by ${WORKER_ID}`,
      payloadEcho: payload,
      elapsedMs: Date.now() - started,
    };
  })();

  return Promise.race([workPromise, timeoutPromise]);
}

async function workLoop() {
  for (;;) {
    try {
      const next = await post("/task/next", { workerId: WORKER_ID });
      if (!next.task) {
        await sleep(POLL_MS);
        continue;
      }

      try {
        const result = await executeTask(next.task);
        await post("/task/result", {
          workerId: WORKER_ID,
          taskId: next.task.id,
          status: "done",
          result,
        });
      } catch (error) {
        await post("/task/result", {
          workerId: WORKER_ID,
          taskId: next.task.id,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      console.error(JSON.stringify({ level: "error", workerId: WORKER_ID, msg: String(error) }));
      await sleep(POLL_MS);
    }
  }
}

async function main() {
  await register();
  await heartbeat("online");

  setInterval(() => {
    heartbeat("online").catch((error) => {
      console.error(JSON.stringify({ level: "warn", workerId: WORKER_ID, heartbeatError: String(error) }));
    });
  }, HEARTBEAT_MS).unref();

  console.log(
    JSON.stringify({
      ok: true,
      role: "worker",
      profile: SELECTED_PROFILE.id,
      workerId: WORKER_ID,
      caps: CAPS,
      main: MAIN_URL,
      auth: API_TOKEN ? "token" : "disabled",
    })
  );
  await workLoop();
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, workerId: WORKER_ID, error: String(error) }));
  process.exitCode = 1;
});
