const MAIN_URL = (process.env.PF_MAIN_URL ?? "http://127.0.0.1:18791").replace(/\/+$/, "");
const API_TOKEN = String(process.env.PF_API_TOKEN ?? "").trim();

const [, , typeArg, payloadArg, targetWorkerArg, maxAttemptsArg, timeoutMsArg] = process.argv;
const type = typeArg ?? "general.task";
const payload = payloadArg ? JSON.parse(payloadArg) : { message: "hello from enqueue helper" };
const targetWorkerId = targetWorkerArg ?? null;
const maxAttempts = maxAttemptsArg ? Number.parseInt(maxAttemptsArg, 10) : undefined;
const timeoutMs = timeoutMsArg ? Number.parseInt(timeoutMsArg, 10) : undefined;

const headers = { "content-type": "application/json" };
if (API_TOKEN) headers.authorization = `Bearer ${API_TOKEN}`;

const res = await fetch(`${MAIN_URL}/task/enqueue`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    type,
    payload,
    targetWorkerId,
    maxAttempts,
    timeoutMs,
  }),
});

const data = await res.json().catch(() => ({}));
if (!res.ok || !data.ok) {
  console.error(JSON.stringify({ ok: false, error: data.error ?? "enqueue failed" }));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, taskId: data.taskId, type, targetWorkerId, maxAttempts: data.maxAttempts, timeoutMs: data.timeoutMs }));
