// Test stream protocol (ALPN bench/0, shared with the tailcat spike harness). First byte of
// each client-opened stream selects the behavior:
//   'U'              upload: server reads to EOF, replies with the 8-byte BE count, finishes
//   'D' + u64 BE n   download: server writes n bytes, finishes
//   'E'              echo: server writes back every chunk until EOF
"use strict";
const crypto = require("node:crypto");

const ALPN = Buffer.from("bench/0");
const CHUNK = 1 << 20;
// One reusable random payload; contents do not matter for throughput.
const PAYLOAD = crypto.randomBytes(CHUNK);

/** Serves one stream ({ write, finish, read }) according to its command byte. */
async function serveStream(s) {
  let first = await s.read(9);
  if (!first) {
    return;
  }
  const cmd = String.fromCharCode(first[0]);
  if (cmd === "U") {
    let n = first.length - 1;
    for (let b; (b = await s.read(CHUNK));) {
      n += b.length;
    }
    const out = Buffer.alloc(8);
    out.writeBigUInt64BE(BigInt(n));
    await s.write(out);
    await s.finish();
  } else if (cmd === "D") {
    // The 9-byte command may arrive split across reads.
    while (first.length < 9) {
      first = Buffer.concat([first, await s.read(9 - first.length)]);
    }
    let left = Number(first.readBigUInt64BE(1));
    while (left > 0) {
      const n = Math.min(left, CHUNK);
      await s.write(n === CHUNK ? PAYLOAD : PAYLOAD.subarray(0, n));
      left -= n;
    }
    await s.finish();
  } else if (cmd === "E") {
    if (first.length > 1) {
      await s.write(first.subarray(1));
    }
    for (let b; (b = await s.read(CHUNK));) {
      await s.write(b);
    }
    await s.finish();
  }
}

/** Accepts connections and their streams until the endpoint closes, serving each stream. */
async function serveEndpoint(ep, onError = () => {}) {
  for (;;) {
    let c;
    try {
      c = await ep.accept();
    } catch (e) {
      onError(e);
      continue;
    }
    if (!c) {
      return;
    }
    void serveConnection(c, onError);
  }
}

// Serves every stream of one connection until it closes.
async function serveConnection(c, onError) {
  for (;;) {
    let s;
    try {
      s = await c.acceptBi();
    } catch {
      return;
    }
    serveStream(s).catch(onError);
  }
}

/** Downloads n bytes on a fresh stream; returns the byte count received. */
async function download(conn, n) {
  const s = await conn.openBi();
  const cmd = Buffer.alloc(9);
  cmd[0] = 68; // 'D'
  cmd.writeBigUInt64BE(BigInt(n), 1);
  await s.write(cmd);
  await s.finish();
  let got = 0;
  for (let b; (b = await s.read(CHUNK));) {
    got += b.length;
  }
  if (got !== n) {
    throw new Error("download short: " + got);
  }
  return got;
}

/** Uploads n bytes on a fresh stream and checks the server's byte count. */
async function upload(conn, n) {
  const s = await conn.openBi();
  await s.write(Buffer.from("U"));
  for (let left = n; left > 0; left -= CHUNK) {
    await s.write(left >= CHUNK ? PAYLOAD : PAYLOAD.subarray(0, left));
  }
  await s.finish();
  const ack = await s.read(8);
  if (Number(ack.readBigUInt64BE(0)) !== n) {
    throw new Error("upload count mismatch");
  }
}

/** Echoes n random bytes through 'E' and returns { sent, received } SHA-256 digests. */
async function echo(conn, n) {
  const s = await conn.openBi();
  const data = crypto.randomBytes(n);
  await s.write(Buffer.from("E"));
  const sending = (async () => {
    for (let o = 0; o < n; o += 65536) {
      await s.write(data.subarray(o, o + 65536));
    }
    await s.finish();
  })();
  const parts = [];
  for (let b; (b = await s.read(CHUNK));) {
    parts.push(b);
  }
  await sending;
  return { sent: sha256(data), received: sha256(Buffer.concat(parts)) };
}

/** Hex SHA-256 of a buffer. */
function sha256(b) {
  return crypto.createHash("sha256").update(b).digest("hex");
}

module.exports = {
  ALPN,
  CHUNK,
  PAYLOAD,
  serveStream,
  serveEndpoint,
  download,
  upload,
  echo,
  sha256,
};
