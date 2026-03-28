const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ========== WebSocket Protocol (RFC 6455) ==========

const OPCODES = { TEXT: 0x01, CLOSE: 0x08, PING: 0x09, PONG: 0x0a };
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function computeAcceptKey(clientKey) {
  return crypto
    .createHash("sha1")
    .update(clientKey + WS_MAGIC)
    .digest("base64");
}

function encodeFrame(opcode, payload) {
  const fin = 0x80;
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = fin | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = fin | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = fin | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;

  const secondByte = buffer[1];
  const opcode = buffer[0] & 0x0f;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLen = secondByte & 0x7f;
  let offset = 2;

  if (!masked) throw new Error("Client frames must be masked");

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  const maskOffset = offset;
  const dataOffset = offset + 4;
  const totalLen = dataOffset + payloadLen;
  if (buffer.length < totalLen) return null;

  const mask = buffer.slice(maskOffset, dataOffset);
  const data = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    data[i] = buffer[dataOffset + i] ^ mask[i % 4];
  }

  return { opcode, payload: data, bytesConsumed: totalLen };
}

// ========== Configuration ==========

const PORT = process.env.BRAINSTORM_PORT || 49152 + Math.floor(Math.random() * 16383);
const HOST = process.env.BRAINSTORM_HOST || "127.0.0.1";
const URL_HOST = process.env.BRAINSTORM_URL_HOST || (HOST === "127.0.0.1" ? "localhost" : HOST);
const SESSION_DIR = process.env.BRAINSTORM_DIR || "/tmp/brainstorm";
const CONTENT_DIR = path.join(SESSION_DIR, "content");
const STATE_DIR = path.join(SESSION_DIR, "state");
let ownerPid = process.env.BRAINSTORM_OWNER_PID ? Number(process.env.BRAINSTORM_OWNER_PID) : null;

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

// ========== Templates and Constants ==========

const WAITING_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Brainstorm Companion</title>
<style>body { font-family: system-ui, sans-serif; padding: 2rem; max-width: 800px; margin: 0 auto; }
h1 { color: #333; } p { color: #666; }</style>
</head>
<body><h1>Brainstorm Companion</h1>
<p>Waiting for the agent to push a screen...</p></body></html>`;

const frameTemplate = fs.readFileSync(path.join(__dirname, "frame-template.html"), "utf-8");
const helperScript = fs.readFileSync(path.join(__dirname, "helper.js"), "utf-8");
const helperInjection = "<script>\n" + helperScript + "\n</script>";

// ========== Helper Functions ==========

function isFullDocument(html) {
  const trimmed = html.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype") || trimmed.startsWith("<html");
}

function wrapInFrame(content) {
  return frameTemplate.replace("<!-- CONTENT -->", content);
}

function getNewestScreen() {
  const files = fs
    .readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(".html"))
    .map((f) => {
      const fp = path.join(CONTENT_DIR, f);
      return { path: fp, mtime: fs.statSync(fp).mtime.getTime() };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].path : null;
}

// ========== HTTP Request Handler ==========

function handleRequest(req, res) {
  touchActivity();
  if (req.method === "GET" && req.url === "/") {
    const screenFile = getNewestScreen();
    let html = screenFile
      ? ((raw) => (isFullDocument(raw) ? raw : wrapInFrame(raw)))(
          fs.readFileSync(screenFile, "utf-8"),
        )
      : WAITING_PAGE;

    if (html.includes("</body>")) {
      html = html.replace("</body>", helperInjection + "\n</body>");
    } else {
      html += helperInjection;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } else if (req.method === "GET" && req.url.startsWith("/files/")) {
    const fileName = req.url.slice(7);
    const filePath = path.join(CONTENT_DIR, path.basename(fileName));
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ========== WebSocket Connection Handling ==========

const clients = new Set();

function handleUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = computeAcceptKey(key);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " +
      accept +
      "\r\n\r\n",
  );

  let buffer = Buffer.alloc(0);
  clients.add(socket);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      let result;
      try {
        result = decodeFrame(buffer);
      } catch (e) {
        socket.end(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
        clients.delete(socket);
        return;
      }
      if (!result) break;
      buffer = buffer.slice(result.bytesConsumed);

      switch (result.opcode) {
        case OPCODES.TEXT:
          handleMessage(result.payload.toString());
          break;
        case OPCODES.CLOSE:
          socket.end(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
          clients.delete(socket);
          return;
        case OPCODES.PING:
          socket.write(encodeFrame(OPCODES.PONG, result.payload));
          break;
        case OPCODES.PONG:
          break;
        default: {
          const closeBuf = Buffer.alloc(2);
          closeBuf.writeUInt16BE(1003);
          socket.end(encodeFrame(OPCODES.CLOSE, closeBuf));
          clients.delete(socket);
          return;
        }
      }
    }
  });

  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
}

function handleMessage(text) {
  let event;
  try {
    event = JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse WebSocket message:", e.message);
    return;
  }
  touchActivity();
  console.log(JSON.stringify({ source: "user-event", ...event }));
  if (event.choice) {
    const eventsFile = path.join(STATE_DIR, "events");
    fs.appendFileSync(eventsFile, JSON.stringify(event) + "\n");
  }
}

function broadcast(msg) {
  const frame = encodeFrame(OPCODES.TEXT, Buffer.from(JSON.stringify(msg)));
  for (const socket of clients) {
    try {
      socket.write(frame);
    } catch (e) {
      clients.delete(socket);
    }
  }
}

// ========== Activity Tracking ==========

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
let lastActivity = Date.now();

function touchActivity() {
  lastActivity = Date.now();
}

// ========== File Watching ==========

const debounceTimers = new Map();

// ========== Server Startup ==========

function startServer() {
  if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

  // Track known files to distinguish new screens from updates.
  // macOS fs.watch reports 'rename' for both new files and overwrites,
  // so we can't rely on eventType alone.
  const knownFiles = new Set(fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".html")));

  const server = http.createServer(handleRequest);
  server.on("upgrade", handleUpgrade);

  const watcher = fs.watch(CONTENT_DIR, (eventType, filename) => {
    if (!filename || !filename.endsWith(".html")) return;

    if (debounceTimers.has(filename)) clearTimeout(debounceTimers.get(filename));
    debounceTimers.set(
      filename,
      setTimeout(() => {
        debounceTimers.delete(filename);
        const filePath = path.join(CONTENT_DIR, filename);

        if (!fs.existsSync(filePath)) return; // file was deleted
        touchActivity();

        if (!knownFiles.has(filename)) {
          knownFiles.add(filename);
          const eventsFile = path.join(STATE_DIR, "events");
          if (fs.existsSync(eventsFile)) fs.unlinkSync(eventsFile);
          console.log(JSON.stringify({ type: "screen-added", file: filePath }));
        } else {
          console.log(JSON.stringify({ type: "screen-updated", file: filePath }));
        }

        broadcast({ type: "reload" });
      }, 100),
    );
  });
  watcher.on("error", (err) => console.error("fs.watch error:", err.message));

  function shutdown(reason) {
    console.log(JSON.stringify({ type: "server-stopped", reason }));
    const infoFile = path.join(STATE_DIR, "server-info");
    if (fs.existsSync(infoFile)) fs.unlinkSync(infoFile);
    fs.writeFileSync(
      path.join(STATE_DIR, "server-stopped"),
      JSON.stringify({ reason, timestamp: Date.now() }) + "\n",
    );
    watcher.close();
    clearInterval(lifecycleCheck);
    server.close(() => process.exit(0));
  }

  function ownerAlive() {
    if (!ownerPid) return true;
    try {
      process.kill(ownerPid, 0);
      return true;
    } catch (e) {
      return e.code === "EPERM";
    }
  }

  // Check every 60s: exit if owner process died or idle for 30 minutes
  const lifecycleCheck = setInterval(() => {
    if (!ownerAlive()) shutdown("owner process exited");
    else if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) shutdown("idle timeout");
  }, 60 * 1000);
  lifecycleCheck.unref();

  // Validate owner PID at startup. If it's already dead, the PID resolution
  // was wrong (common on WSL, Tailscale SSH, and cross-user scenarios).
  // Disable monitoring and rely on the idle timeout instead.
  if (ownerPid) {
    try {
      process.kill(ownerPid, 0);
    } catch (e) {
      if (e.code !== "EPERM") {
        console.log(
          JSON.stringify({ type: "owner-pid-invalid", pid: ownerPid, reason: "dead at startup" }),
        );
        ownerPid = null;
      }
    }
  }

  server.listen(PORT, HOST, () => {
    const info = JSON.stringify({
      type: "server-started",
      port: Number(PORT),
      host: HOST,
      url_host: URL_HOST,
      url: "http://" + URL_HOST + ":" + PORT,
      screen_dir: CONTENT_DIR,
      state_dir: STATE_DIR,
    });
    console.log(info);
    fs.writeFileSync(path.join(STATE_DIR, "server-info"), info + "\n");
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { computeAcceptKey, encodeFrame, decodeFrame, OPCODES };
