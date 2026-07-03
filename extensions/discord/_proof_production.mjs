import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { setGlobalDispatcher, ProxyAgent } from "undici";
// Production path proof: runs OpenClaw's patched sendMessageDiscord
// against a real Discord API with an oversized ZIP file, demonstrating
// the 413 -> text-only fallback via the actual code path.
// Usage: HTTP_PROXY=... DISCORD_BOT_TOKEN=... CHANNEL_ID=... node --import tsx _proof_production.mjs
import { sendMessageDiscord } from "./src/send.outbound.ts";

// Proxy is optional — set HTTP_PROXY env var if behind a corporate proxy.
if (process.env.HTTP_PROXY) {
  setGlobalDispatcher(new ProxyAgent(process.env.HTTP_PROXY));
}

const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.CHANNEL_ID;

console.log("=== PRODUCTION PATH PROOF: OpenClaw send path -> real Discord 413 ===");
console.log("Host: " + hostname());
console.log("Time: " + new Date().toISOString());
console.log("");

console.log("--- Step 1: Send oversized ZIP (12MB > 10MB Discord limit) via patched path ---");
try {
  const result = await sendMessageDiscord(
    `channel:${channelId}`,
    "Production proof: patched send handles 413 with text fallback.",
    {
      cfg: { channels: { discord: { token } } },
      mediaUrl: "file:///tmp/proof_oversized.zip",
      filename: "proof_oversized.zip",
      mediaLocalRoots: ["/tmp"],
      mediaReadFile: async (path) => readFileSync(path),
    },
  );
  console.log("Message ID: " + result.messageId);
  const kind = result.receipt?.parts?.[0]?.kind ?? "unknown";
  console.log("Receipt kind: " + kind);
  if (kind === "text") {
    console.log("*** PATCHED PATH TRIGGERED 413 AND DELIVERED TEXT FALLBACK ***");
  } else {
    console.log("FAIL: expected receipt kind 'text' (proves 413 was hit) but got '" + kind + "'");
    process.exit(1);
  }
} catch (err) {
  console.error("Send failed: " + (err.message || err));
  console.log("(this may indicate the 413 was not caught by the fallback)");
  process.exit(1);
}

console.log("");
console.log("--- Step 2: Normal text-only send via same patched path ---");
try {
  const textResult = await sendMessageDiscord(
    `channel:${channelId}`,
    "Production proof: text-only send works.",
    { cfg: { channels: { discord: { token } } } },
  );
  console.log("Message ID: " + textResult.messageId);
  console.log("");
  console.log("=== RESULT: OpenClaw patched send path confirmed working ===");
} catch (err) {
  console.error("Text send failed: " + (err.message || err));
  process.exit(1);
}
