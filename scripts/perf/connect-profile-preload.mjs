// Native, synthetic-only transport for connect-tail-measure.ts --auth cloudflare.
// Access and GitHub requests each wait OPENCLAW_BENCH_IDENTITY_DELAY_MS (0–4000 ms).
// Only loopback requests may reach the network; no assertions or identities are logged.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";

const delayMs = Number(process.env.OPENCLAW_BENCH_IDENTITY_DELAY_MS);
assert(Number.isSafeInteger(delayMs) && delayMs >= 0 && delayMs <= 4_000);
assert(process.env.OPENCLAW_CONFIG_PATH && process.env.OPENCLAW_STATE_DIR);
const nativeFetch = globalThis.fetch;
const counts = { access: 0, github: 0, blocked: 0 };
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
    return nativeFetch(input, { ...init, redirect: "error" });
  }
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  let payload;
  if (
    url.origin === "https://connect-profile.cloudflareaccess.com" &&
    url.pathname === "/cdn-cgi/access/get-identity"
  ) {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    const cookie = headers.get("cookie") ?? "";
    const match = /^CF_Authorization=synthetic\.([A-Za-z0-9_-]+)\.synthetic$/u.exec(cookie);
    assert(match, "Synthetic Access assertion required");
    const claims = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    assert(
      typeof claims.email === "string" &&
        claims.email.endsWith("@example.com") &&
        Number.isSafeInteger(claims.accountId) &&
        claims.accountId > 0,
      "Synthetic identity claims required",
    );
    counts.access++;
    payload = { email: claims.email, id: claims.accountId, idp: { type: "github" } };
  } else if (
    url.origin === "https://api.github.com" &&
    /^\/user\/[1-9][0-9]*$/u.test(url.pathname)
  ) {
    counts.github++;
    const id = Number(url.pathname.slice("/user/".length));
    payload = { id, login: `synthetic-${id}`, name: `Synthetic profile ${id}` };
  } else {
    counts.blocked++;
    throw new Error("Connect profile benchmark blocked a non-loopback fetch");
  }
  signal?.throwIfAborted();
  if (delayMs > 0) {
    await delay(delayMs, undefined, { signal });
  }
  return Response.json(payload);
};
if (isMainThread) {
  process.on("exit", () => {
    writeFileSync(
      path.join(path.dirname(process.env.OPENCLAW_CONFIG_PATH), "identity-dependency.json"),
      JSON.stringify({ delayMs, ...counts }),
    );
  });
}
