import { WebSocket } from "ws";

const to = process.argv[2] || "+918527464661";
const message = process.argv[3] || "Hello from Widgety Cruise Sales!";

const ws = new WebSocket("ws://127.0.0.1:18789/ws");

ws.on("open", () => {
  console.log("✅ Connected to gateway");
  const req = {
    type: "rpc",
    id: "call-" + Date.now(),
    method: "voicecall.initiate",
    params: { to, message, mode: "conversation" },
  };
  console.log("📞 Initiating call to:", to);
  ws.send(JSON.stringify(req));
});

ws.on("message", (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.result) {
      console.log("✅ Call initiated:", JSON.stringify(msg.result, null, 2));
    } else if (msg.error) {
      console.log("❌ Error:", msg.error);
    }
  } catch {
    console.log("Raw:", data.toString());
  }
  ws.close();
});

ws.on("error", (err) => {
  console.error("WebSocket error:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log("Timeout");
  ws.close();
  process.exit(0);
}, 10000);
