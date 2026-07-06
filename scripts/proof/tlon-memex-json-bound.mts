// Real behavior proof: Tlon Memex upload now uses a bounded JSON reader so
// an oversized body cannot OOM the runtime.
//
// The proof constructs a Response whose body exceeds the 64 KiB cap used by
// `uploadFile`, then exercises the same `readProviderJsonResponse` reader the
// Memex upload path now uses. With the fix the reader rejects with a clear
// byte-cap error; without the bound the runtime would buffer the entire
// oversized body before parsing.

import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";

const hugeBody = JSON.stringify({
  url: "https://uploads.tlon.network/put",
  filePath: "https://memex.tlon.network/files/uploaded.png",
  padding: "x".repeat(128 * 1024),
});

const response = new Response(
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(hugeBody));
      controller.close();
    },
  }),
  { status: 200, headers: { "content-type": "application/json" } },
);

console.log("=== Proof: Tlon Memex upload JSON response bound ===\n");

try {
  await readProviderJsonResponse<unknown>(response, "Memex upload", { maxBytes: 64 * 1024 });
  console.log("FAIL: readProviderJsonResponse should have rejected");
  process.exitCode = 1;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Memex upload: JSON response exceeds")) {
    console.log("PASS: oversized Memex upload JSON response was rejected without OOM.");
  } else {
    console.log("FAIL: unexpected rejection:", message);
    process.exitCode = 1;
  }
}
