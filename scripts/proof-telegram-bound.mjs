import { once } from "node:events";
// Proof script: verifies readResponseWithLimit stops Telegram Bot API response reads at the cap.
import { createServer } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = resolve(__dirname, "..");

const { readResponseWithLimit } = await import(
  `${pkgRoot}/packages/media-core/src/read-response-with-limit.ts`
).catch(() => import("@openclaw/media-core/read-response-with-limit"));

const CAP = 1 * 1024 * 1024; // 1 MiB proof cap
const STREAM_SIZE = 24 * 1024 * 1024; // 24 MiB – simulates hostile oversized Bot API response

let allPassed = true;
function check(label, val) {
  console.log(`  ${val ? "ok" : "FAIL"}: ${label}`);
  if (!val) allPassed = false;
}

// Server-side byte counter: track how many response bytes were actually written to the socket.
let serverBytesWritten = 0;

async function withServer(fn) {
  serverBytesWritten = 0;
  const server = createServer((req, res) => {
    if (req.url === "/huge") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const chunk = Buffer.alloc(65536, 120); // 64 KiB of 'x'
      const header = Buffer.from('{"ok":true,"result":[');
      res.write(header);
      serverBytesWritten += header.length;

      let sent = header.length;
      const writeNext = () => {
        if (sent >= STREAM_SIZE) {
          const tail = Buffer.from("]}");
          res.write(tail);
          serverBytesWritten += tail.length;
          res.end();
          return;
        }
        const ok = res.write(chunk);
        serverBytesWritten += chunk.length;
        sent += chunk.length;
        if (ok) {
          setImmediate(writeNext);
        } else {
          res.once("drain", writeNext);
        }
      };
      writeNext();
    } else {
      const body = JSON.stringify({
        ok: true,
        result: {
          id: 123456789,
          is_bot: true,
          username: "my_test_bot",
          first_name: "TestBot",
        },
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      });
      res.end(body);
      serverBytesWritten += Buffer.byteLength(body);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await fn(port, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

console.log(`\n[proof] Telegram Bot API response-limit`);
console.log(`  cap=${CAP} bytes (1 MiB), would-stream≈${STREAM_SIZE} bytes (24 MiB)\n`);

// ── Case 1: readResponseWithLimit rejects oversized body ─────────────────────
await withServer(async (port) => {
  serverBytesWritten = 0;
  const res = await fetch(`http://127.0.0.1:${port}/huge`);
  let err;
  try {
    await readResponseWithLimit(res, CAP);
  } catch (e) {
    err = e;
  }
  // Give server a tick to flush its internal counter before checking
  await new Promise((r) => setTimeout(r, 50));
  const sent = serverBytesWritten;
  check(`oversized body rejected (threw=${!!err})`, !!err);
  check(
    `error message contains limit info: "${err?.message?.slice(0, 80)}"`,
    !!err?.message?.includes("limit"),
  );
  check(
    `server wrote ≈${sent} bytes, well below 24 MiB (stream was cancelled early)`,
    sent < STREAM_SIZE * 0.1,
  );
});

// ── Negative control: unbounded .json() reads the FULL 24 MiB ────────────────
await withServer(async (port) => {
  serverBytesWritten = 0;
  const res2 = await fetch(`http://127.0.0.1:${port}/huge`);
  await res2.json().catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  const sent2 = serverBytesWritten;
  check(
    `negative control: unbounded .json() caused server to write ≈${sent2} bytes (>> ${CAP})`,
    sent2 > CAP,
  );
});

// ── Case 3: small happy-path response (like real getMe / getUpdates OK) ───────
await withServer(async (port) => {
  const res3 = await fetch(`http://127.0.0.1:${port}/small`);
  const buf = await readResponseWithLimit(res3, CAP);
  const parsed = JSON.parse(buf.toString("utf8"));
  check(
    `small response parsed correctly (ok=${parsed?.ok} id=${parsed?.result?.id})`,
    parsed?.ok === true && parsed?.result?.id === 123456789,
  );
  check(`result bytes within cap (${buf.length} < ${CAP})`, buf.length > 0 && buf.length < CAP);
});

console.log(allPassed ? "\nALL PROOF ASSERTIONS PASSED" : "\nSOME ASSERTIONS FAILED");
process.exit(allPassed ? 0 : 1);
