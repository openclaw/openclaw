// L2 loopback proof: local HTTP server simulates MS Teams Graph API responses,
// calls the real readResponseWithLimit to verify bounded read behavior.
// No vitest / mock framework. Real HTTP, real streaming, real overflow detection.
import { createServer } from "node:http";
import { readResponseWithLimit } from "../../packages/media-core/src/read-response-with-limit";

const MSTEAMS_GRAPH_JSON_MAX_BYTES = 256 * 1024; // 256 KiB

function buildJsonResponse(obj) {
  const body = JSON.stringify(obj);
  return { body, length: Buffer.byteLength(body, "utf-8") };
}

const SMALL = buildJsonResponse({ value: [{ id: "1", name: "test attachment" }] });
const LARGE = buildJsonResponse({
  value: Array.from({ length: 50000 }, (_, i) => ({
    id: `item-${i}`,
    name: `attachment-${i}`,
    padding: "x".repeat(40),
  })),
});

let server;
const PORT = 19833;

console.log("========== L2 LOOPBACK PROOF — PR #98833 ==========");
console.log("Function: readResponseWithLimit (real HTTP, real streaming)");
console.log(`Cap: ${MSTEAMS_GRAPH_JSON_MAX_BYTES} bytes (256 KiB)`);
console.log("");

await new Promise((resolve) => {
  server = createServer((_req, res) => {
    const url = _req.url ?? "/";
    if (url === "/normal") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(SMALL.body);
    } else if (url === "/oversized") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(LARGE.body);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  server.listen(PORT, () => resolve());
});

console.log(`Local server started on port ${PORT}`);
console.log(`  /normal    → ${SMALL.length} bytes (< 256 KiB)`);
console.log(`  /oversized → ${LARGE.length} bytes (> 256 KiB)`);
console.log("");

// Test 1: Normal response under cap
console.log("--- Test 1: Normal response (< 256 KiB) ---");
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/normal`);
  const bytes = await readResponseWithLimit(res, MSTEAMS_GRAPH_JSON_MAX_BYTES, {
    onOverflow: ({ size, maxBytes }) =>
      new Error(`MS Teams Graph response exceeds ${maxBytes} bytes (got ${size})`),
  });
  const data = JSON.parse(new TextDecoder().decode(bytes));
  console.log(
    `✅ PASS: Normal response processed. ${bytes.length} bytes, ${data.value.length} items`,
  );
} catch (err) {
  console.log(`❌ FAIL: ${err.message}`);
}

console.log("");

// Test 2: Oversized response exceeds cap
console.log(`--- Test 2: Oversized response (> ${MSTEAMS_GRAPH_JSON_MAX_BYTES} bytes) ---`);
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/oversized`);
  const bytes = await readResponseWithLimit(res, MSTEAMS_GRAPH_JSON_MAX_BYTES, {
    onOverflow: ({ size, maxBytes }) =>
      new Error(`MS Teams Graph response exceeds ${maxBytes} bytes (got ${size})`),
  });
  console.log(`❌ FAIL: Should have thrown overflow, but got ${bytes.length} bytes`);
} catch (err) {
  if (err.message.includes("exceeds")) {
    console.log(`✅ PASS: Overflow correctly detected — "${err.message}"`);
  } else {
    console.log(`❌ UNEXPECTED ERROR: ${err.message}`);
  }
}

console.log("");

// Test 3: Exact cap boundary — response at exactly maxBytes
console.log(`--- Test 3: Response at exact cap (${MSTEAMS_GRAPH_JSON_MAX_BYTES} bytes) ---`);
const exactBody = "x".repeat(MSTEAMS_GRAPH_JSON_MAX_BYTES);
try {
  const exactRes = new Response(exactBody);
  const bytes = await readResponseWithLimit(exactRes, MSTEAMS_GRAPH_JSON_MAX_BYTES, {
    onOverflow: ({ size, maxBytes }) =>
      new Error(`MS Teams Graph response exceeds ${maxBytes} bytes (got ${size})`),
  });
  console.log(`✅ PASS: Exact-cap response accepted. ${bytes.length} bytes`);
} catch (err) {
  console.log(`❌ FAIL: ${err.message}`);
}

server.close();
console.log("");
console.log("Server stopped. Loopback evidence complete.");
