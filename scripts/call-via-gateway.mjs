import { callGateway } from "../dist/gateway/call.js";

const message = process.argv[2] || "Hello from Widgety Cruise Sales!";
const to = process.argv[3] || "+918527464661";

async function main() {
  try {
    console.log("📞 Calling voicecall.initiate via Gateway RPC...");
    console.log("   To:", to);
    console.log("   Message:", message.substring(0, 50) + "...");
    const result = await callGateway({
      method: "voicecall.initiate",
      params: { to, message, mode: "conversation" },
      timeoutMs: 30000,
    });
    console.log("✅ Result:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

main();
