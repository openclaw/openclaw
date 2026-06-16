// HTTP probe for OpenWebUI E2E scenarios.
import { readPositiveIntEnv } from "../env-limits.mjs";

const [url, expectedRaw = "200"] = process.argv.slice(2);
if (!url) {
  throw new Error("usage: http-probe.mjs <url> [status|lt500]");
}

function parseExpectedStatus(raw) {
  if (!/^[1-5]\d\d$/u.test(raw)) {
    throw new Error(`expected status must be lt500 or a decimal HTTP status. Got: ${raw}`);
  }
  return Number(raw);
}

const timeoutMs = readPositiveIntEnv("OPENCLAW_HTTP_PROBE_TIMEOUT_MS", 30_000);
const expectedStatus = expectedRaw === "lt500" ? undefined : parseExpectedStatus(expectedRaw);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);

try {
  const headers = {};
  if (process.env.OPENCLAW_HTTP_PROBE_BEARER) {
    headers.authorization = `Bearer ${process.env.OPENCLAW_HTTP_PROBE_BEARER}`;
  }
  const res = await fetch(url, { headers, signal: controller.signal }).catch(() => null);
  const ok =
    expectedRaw === "lt500" ? Boolean(res && res.status < 500) : res?.status === expectedStatus;
  process.exit(ok ? 0 : 1);
} finally {
  clearTimeout(timer);
}
