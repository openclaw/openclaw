// Synthetic imsg JSON-RPC transport; never connects to Messages or reads chat.db.
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
const base = process.env.INGRESS_BENCH_URL;
const args = process.argv.slice(2);
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
      await fetch(`${base}/watch`, { method: "POST" });
      void (async () => {
        while (!stop.signal.aborted) {
          const response = await fetch(`${base}/next`);
          const events = await response.json();
          for (const event of events) {
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
      await fetch(`${base}/sent`, { method: "POST" });
      result = { guid: "synthetic-outbound" };
    }
    emit({ jsonrpc: "2.0", id: request.id, result });
  }
} else if (args[0] === "send") {
  await fetch(`${base}/sent`, { method: "POST" });
  console.log(JSON.stringify({ guid: "synthetic-outbound" }));
} else {
  console.log("[]");
}
