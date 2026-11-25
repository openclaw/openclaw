// Synthetic-only imsg bridge. Reply text stays on loopback and is never logged.
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const base = new URL(process.env.INGRESS_BENCH_URL);
assert.equal(base.hostname, "127.0.0.1");
const args = process.argv.slice(2);
let nextGuid = 0;
async function sent(params) {
  const response = await fetch(new URL("/sent", base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  assert(response.ok, "Synthetic reply validation failed");
  return { guid: `synthetic-cost-outbound-${process.pid}-${++nextGuid}` };
}
if (args.includes("--help")) {
  console.log("rpc send --text --file");
} else if (args[0] === "status") {
  console.log(JSON.stringify({ advanced_features: false, v2_ready: false, rpc_methods: [] }));
} else if (args[0] === "rpc") {
  const stop = new AbortController();
  const lines = createInterface({ input: process.stdin });
  const emit = (value) => console.log(JSON.stringify(value));
  for await (const line of lines) {
    const request = JSON.parse(line);
    let result = {};
    if (request.method === "chats.list") {
      result = { chats: [] };
    }
    if (request.method === "watch.subscribe") {
      result = { subscription: 1 };
      await fetch(new URL("/watch", base), { method: "POST" });
      void (async () => {
        while (!stop.signal.aborted) {
          const response = await fetch(new URL("/next", base));
          for (const event of await response.json()) {
            emit({ jsonrpc: "2.0", method: "message", params: { message: event } });
          }
          await delay(25);
        }
      })().catch(() => process.exit(1));
    }
    if (request.method === "watch.unsubscribe") {
      stop.abort();
    }
    if (request.method === "send") {
      result = await sent(request.params);
    }
    emit({ jsonrpc: "2.0", id: request.id, result });
  }
} else if (args[0] === "send") {
  const option = (name) => args[args.indexOf(name) + 1];
  console.log(
    JSON.stringify(
      await sent({
        text: option("--text"),
        to: args.includes("--to") ? option("--to") : undefined,
        chat_id: args.includes("--chat-id") ? Number(option("--chat-id")) : undefined,
      }),
    ),
  );
} else {
  console.log("[]");
}
