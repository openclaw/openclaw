import { spawnSync } from "node:child_process";
import { once } from "node:events";
/**
 * Path-level proof: fix(qa-lab) bound Telegram live transport JSON reads
 *
 * Drives readProviderJsonResponse against Telegram Bot API-shaped JSON over
 * node:http streaming responses, then runs the qa-lab regression test.
 *
 * Run: node scripts/proof-qa-lab-telegram-bound.mjs
 */
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CAP_BYTES = 16 * 1024 * 1024;
const MiB = 1024 * 1024;
const STREAM_CHUNKS = 18;
const LABEL = "qa-lab-telegram-live.getMe";

const { readProviderJsonResponse } = await import(
  join(repoRoot, "dist/plugin-sdk/provider-http.js")
);

let allPassed = true;

function check(label, val) {
  const mark = val ? "ok" : "FAIL";
  console.log(`  ${mark}: ${label}`);
  if (!val) {
    allPassed = false;
  }
}

function makeBufferedResponse(bodyString, status = 200) {
  const buf = Buffer.from(bodyString, "utf8");
  return new Response(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeOversizedTelegramEnvelope() {
  const padding = "x".repeat(CAP_BYTES + 1024);
  return JSON.stringify({ ok: true, result: { blob: padding } });
}

function streamOversizedTelegramJson(res, fillByte = 120) {
  res.writeHead(200, { "Content-Type": "application/json" });
  const chunk = Buffer.alloc(MiB, fillByte);
  res.write('{"ok":true,"result":{"blob":"');
  let chunksSent = 0;
  const writeNext = () => {
    if (chunksSent >= STREAM_CHUNKS) {
      res.write('"}}');
      res.end();
      return;
    }
    const ok = res.write(chunk);
    chunksSent += 1;
    if (ok) {
      setImmediate(writeNext);
    } else {
      res.once("drain", writeNext);
    }
  };
  writeNext();
}

function makeStreamingResponse(chunkCount, chunkSize) {
  const chunk = new Uint8Array(chunkSize);
  let readCount = 0;
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (readCount >= chunkCount) {
          controller.close();
          return;
        }
        readCount += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  return { response, getReadCount: () => readCount, wasCanceled: () => canceled };
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
}

console.log("\n=== QA Lab Telegram live transport bound proof (path-level) ===");

console.log("--- Case 1: oversized streamed Telegram API body rejected at parse boundary ---");
await withServer(
  (_req, res) => streamOversizedTelegramJson(res),
  async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/botTOKEN/getMe`);
    let err;
    try {
      await readProviderJsonResponse(response, LABEL);
    } catch (e) {
      err = e;
    }
    check("readProviderJsonResponse rejects oversized streamed Telegram body", err != null);
    check(
      `parse-boundary label present (got: ${err?.message})`,
      err?.message?.includes(LABEL) || err?.message?.includes("exceeds"),
    );
  },
);

console.log("\n--- Case 2: oversized buffered Telegram envelope (production handoff) ---");
{
  const hugeBody = makeOversizedTelegramEnvelope();
  const response = makeBufferedResponse(hugeBody);
  let err;
  try {
    await readProviderJsonResponse(response, LABEL);
  } catch (e) {
    err = e;
  }
  check("buffered oversized Telegram body rejected before JSON.parse", err != null);
  check(`body size ${hugeBody.length} bytes exceeds ${CAP_BYTES} cap`, hugeBody.length > CAP_BYTES);
}

console.log("\n--- Case 3: normal Telegram getMe envelope still parses ---");
{
  const body = JSON.stringify({
    ok: true,
    result: { id: 42, is_bot: true, username: "qa_lab_bot" },
  });
  const response = makeBufferedResponse(body);
  const payload = await readProviderJsonResponse(response, LABEL);
  check("getMe envelope parses", payload.ok === true);
  check("bot identity intact", payload.result?.username === "qa_lab_bot");
}

console.log("\n--- Case 4: negative control — unbounded response.json() ---");
{
  const streamed = makeStreamingResponse(64, MiB);
  await streamed.response.json().catch(() => {});
  check(
    `unbounded .json() consumed all 64 chunks (readCount=${streamed.getReadCount()})`,
    streamed.getReadCount() === 64,
  );
  check("stream NOT cancelled via .cancel()", !streamed.wasCanceled());
}

console.log("\n--- Case 5: bounded helper cancels oversized injected stream ---");
{
  const streamed = makeStreamingResponse(64, MiB);
  let err;
  try {
    await readProviderJsonResponse(streamed.response, LABEL);
  } catch (e) {
    err = e;
  }
  check("readProviderJsonResponse rejected oversized injected stream", err != null);
  check(
    `stream read stopped early (readCount=${streamed.getReadCount()})`,
    streamed.getReadCount() < 64,
  );
  check("stream cancel() was invoked", streamed.wasCanceled());
}

console.log("\n--- Case 6: qa-lab Telegram live runtime regression test ---");
const vitest = spawnSync(
  "node",
  [
    join(repoRoot, "scripts/run-vitest.mjs"),
    "extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.test.ts",
    "-t",
    "rejects oversized Telegram API success bodies",
  ],
  { cwd: repoRoot, encoding: "utf8", env: { ...process.env, OPENCLAW_VITEST_MAX_WORKERS: "1" } },
);
if (vitest.stdout) {
  for (const line of vitest.stdout.split("\n").filter(Boolean)) {
    if (line.includes("PASS") || line.includes("FAIL") || line.includes("Tests")) {
      console.log(`  ${line.trim()}`);
    }
  }
}
check("vitest qa-lab Telegram bound regression test passed", vitest.status === 0);

console.log(allPassed ? "\nALL PROOF ASSERTIONS PASSED" : "\nSOME ASSERTIONS FAILED");
process.exit(allPassed ? 0 : 1);
