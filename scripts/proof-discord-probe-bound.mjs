import { once } from "node:events";
// Loopback proof: probeDiscord getMe through the production bounded JSON read path.
import { createServer } from "node:http";
import { resolve } from "node:path";

const pkgRoot = resolve(import.meta.dirname, "..");

const { probeDiscord } = await import(`${pkgRoot}/extensions/discord/src/probe.ts`);

const CAP = 16 * 1024 * 1024;
const STREAM_SIZE = 24 * 1024 * 1024;

let allPassed = true;
function check(label, val) {
  console.log(`  ${val ? "ok" : "FAIL"}: ${label}`);
  if (!val) {
    allPassed = false;
  }
}

let serverBytesWritten = 0;

function writeHugeJsonStream(res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  const chunk = Buffer.alloc(65536, 120);
  const header = Buffer.from('{"id":"bot-1","username":"proof"');
  res.write(header);
  serverBytesWritten += header.length;
  let sent = header.length;
  const writeNext = () => {
    if (sent >= STREAM_SIZE) {
      const tail = Buffer.from("}");
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
}

function createHugeServer() {
  return createServer((req, res) => {
    if (req.url === "/huge" || req.url === "/users/@me") {
      writeHugeJsonStream(res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

function createSmallServer() {
  return createServer((req, res) => {
    if (req.url === "/users/@me") {
      const body = JSON.stringify({ id: "bot-1", username: "proof" });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      });
      res.end(body);
      serverBytesWritten += Buffer.byteLength(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

async function withServer(server, fn) {
  serverBytesWritten = 0;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const fetcher = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/users/@me")) {
      return fetch(`http://127.0.0.1:${port}/users/@me`, init);
    }
    return fetch(input, init);
  };
  try {
    await fn(port, fetcher);
  } finally {
    await new Promise((resolveDone) => {
      server.close(resolveDone);
    });
  }
}

console.log(`\n[proof] probeDiscord getMe production path`);
console.log(`  cap=${CAP} bytes (16 MiB), would-stream≈${STREAM_SIZE} bytes (24 MiB)\n`);

await withServer(createHugeServer(), async (_port, fetcher) => {
  serverBytesWritten = 0;
  const result = await probeDiscord("MTIz.abc.def", 5_000, { fetcher });
  await new Promise((done) => {
    setTimeout(done, 50);
  });
  check("oversized getMe probe fails closed (ok=false)", result.ok === false);
  check(
    `bounded error present: "${result.error?.slice(0, 72)}"`,
    String(result.error ?? "").includes(
      "discord.probe.getMe: JSON response exceeds 16777216 bytes",
    ),
  );
  check(
    `server wrote ${serverBytesWritten} bytes, stopped before full 24 MiB stream`,
    serverBytesWritten < STREAM_SIZE && serverBytesWritten > CAP,
  );
});

await withServer(createHugeServer(), async (port) => {
  serverBytesWritten = 0;
  const res = await fetch(`http://127.0.0.1:${port}/huge`);
  await res.json().catch(() => undefined);
  await new Promise((done) => {
    setTimeout(done, 50);
  });
  check(
    `negative control: unbounded .json() wrote ${serverBytesWritten} bytes (>> ${CAP})`,
    serverBytesWritten > CAP,
  );
});

await withServer(createSmallServer(), async (_port, fetcher) => {
  serverBytesWritten = 0;
  const result = await probeDiscord("MTIz.abc.def", 5_000, { fetcher });
  check(
    `small getMe parsed through production path (id=${result.bot?.id}, username=${result.bot?.username})`,
    result.ok === true && result.bot?.id === "bot-1" && result.bot?.username === "proof",
  );
});

console.log(allPassed ? "\nALL PROOF ASSERTIONS PASSED" : "\nSOME ASSERTIONS FAILED");
process.exit(allPassed ? 0 : 1);
