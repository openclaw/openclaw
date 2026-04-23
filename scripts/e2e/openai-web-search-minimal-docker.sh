#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-openai-web-search-minimal-e2e" OPENCLAW_OPENAI_WEB_SEARCH_MINIMAL_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_OPENAI_WEB_SEARCH_MINIMAL_E2E_SKIP_BUILD:-0}"
PORT="18789"
MOCK_PORT="19191"
TOKEN="openai-web-search-minimal-e2e-$$"

docker_e2e_build_or_reuse "$IMAGE_NAME" openai-web-search-minimal "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "$SKIP_BUILD"

echo "Running OpenAI web_search minimal reasoning Docker E2E..."
run_logged openai-web-search-minimal docker run --rm \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENAI_API_KEY=sk-openclaw-web-search-minimal-e2e" \
  -e "BRAVE_API_KEY=brave-openclaw-web-search-minimal-e2e" \
  -e "PORT=$PORT" \
  -e "MOCK_PORT=$MOCK_PORT" \
  -i "$IMAGE_NAME" bash -s <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-openai-web-search-minimal.XXXXXX")"
export OPENCLAW_STATE_DIR="$HOME/.openclaw"
export OPENCLAW_SKIP_CHANNELS=1
export OPENCLAW_SKIP_GMAIL_WATCHER=1
export OPENCLAW_SKIP_CRON=1
export OPENCLAW_SKIP_CANVAS_HOST=1

PORT="${PORT:?missing PORT}"
MOCK_PORT="${MOCK_PORT:?missing MOCK_PORT}"
TOKEN="${OPENCLAW_GATEWAY_TOKEN:?missing OPENCLAW_GATEWAY_TOKEN}"
SUCCESS_MARKER="OPENCLAW_SCHEMA_E2E_OK"
RAW_SCHEMA_ERROR="400 The following tools cannot be used with reasoning.effort 'minimal': web_search."
MOCK_REQUEST_LOG="/tmp/openclaw-openai-web-search-minimal-requests.jsonl"
GATEWAY_LOG="/tmp/openclaw-openai-web-search-minimal-gateway.log"
mock_pid=""
gateway_pid=""

cleanup() {
  if [ -n "${gateway_pid:-}" ] && kill -0 "$gateway_pid" 2>/dev/null; then
    kill "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
  if [ -n "${mock_pid:-}" ] && kill -0 "$mock_pid" 2>/dev/null; then
    kill "$mock_pid" 2>/dev/null || true
    wait "$mock_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

dump_debug_logs() {
  local status="$1"
  echo "OpenAI web_search minimal Docker E2E failed with exit code $status" >&2
  for file in \
    "$GATEWAY_LOG" \
    /tmp/openclaw-openai-web-search-minimal-mock.log \
    /tmp/openclaw-openai-web-search-minimal-client-success.log \
    /tmp/openclaw-openai-web-search-minimal-client-reject.log \
    "$MOCK_REQUEST_LOG" \
    "$OPENCLAW_STATE_DIR/openclaw.json"; do
    if [ -f "$file" ]; then
      echo "--- $file ---" >&2
      sed -n '1,260p' "$file" >&2 || true
    fi
  done
}
trap 'status=$?; dump_debug_logs "$status"; exit "$status"' ERR

entry=dist/index.mjs
[ -f "$entry" ] || entry=dist/index.js
mkdir -p "$OPENCLAW_STATE_DIR"

cat >"$OPENCLAW_STATE_DIR/openclaw.json" <<JSON
{
  "agents": {
    "defaults": {
      "model": { "primary": "openai/gpt-5" },
      "models": {
        "openai/gpt-5": {
          "params": {
            "transport": "sse",
            "openaiWsWarmup": false
          }
        }
      }
    }
  },
  "models": {
    "providers": {
      "openai": {
        "api": "openai-responses",
        "baseUrl": "http://127.0.0.1:${MOCK_PORT}/v1",
        "apiKey": { "source": "env", "provider": "default", "id": "OPENAI_API_KEY" },
        "request": { "allowPrivateNetwork": true },
        "models": [
          {
            "id": "gpt-5",
            "name": "gpt-5",
            "api": "openai-responses",
            "reasoning": true,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128000,
            "contextTokens": 96000,
            "maxTokens": 4096
          }
        ]
      }
    }
  },
  "tools": {
    "web": {
      "search": {
        "enabled": true,
        "provider": "brave",
        "maxResults": 3
      }
    }
  },
  "plugins": {
    "enabled": true,
    "entries": {
      "brave": {
        "enabled": true,
        "config": {
          "webSearch": {
            "apiKey": { "source": "env", "provider": "default", "id": "BRAVE_API_KEY" }
          }
        }
      }
    }
  },
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "${TOKEN}"
    }
  }
}
JSON

cat >/tmp/openclaw-openai-web-search-minimal-mock.mjs <<'NODE'
import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.MOCK_PORT);
const requestLog = process.env.MOCK_REQUEST_LOG;
const successMarker = process.env.SUCCESS_MARKER;
const rawSchemaError = process.env.RAW_SCHEMA_ERROR;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writeOpenAiReject(res) {
  writeJson(res, 400, {
    error: {
      message: rawSchemaError.replace(/^400\s+/, ""),
      type: "invalid_request_error",
      code: "invalid_request_error",
    },
  });
}

function hasWebSearchTool(tools) {
  return Array.isArray(tools) && tools.some((tool) => {
    if (!tool || typeof tool !== "object") return false;
    if (tool.type === "web_search") return true;
    if (tool.type === "function" && tool.name === "web_search") return true;
    if (tool.type === "function" && tool.function?.name === "web_search") return true;
    return false;
  });
}

function bodyContainsForceReject(body) {
  return JSON.stringify(body).includes("FORCE_SCHEMA_REJECT");
}

function responseEvents(text) {
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: "msg_schema_e2e_1",
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_schema_e2e_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_schema_e2e_1",
        status: "completed",
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
}

function writeSse(res, events) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    writeJson(res, 200, {
      object: "list",
      data: [{ id: "gpt-5", object: "model", owned_by: "openclaw-e2e" }],
    });
    return;
  }

  const bodyText = await readBody(req);
  let body = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = {};
  }
  fs.appendFileSync(requestLog, `${JSON.stringify({ method: req.method, path: url.pathname, body })}\n`);

  if (req.method === "POST" && url.pathname === "/v1/responses") {
    if (bodyContainsForceReject(body)) {
      writeOpenAiReject(res);
      return;
    }
    if (body?.reasoning?.effort === "minimal" && hasWebSearchTool(body.tools)) {
      writeOpenAiReject(res);
      return;
    }
    writeSse(res, responseEvents(successMarker));
    return;
  }

  writeJson(res, 404, { error: { message: `unhandled mock route: ${req.method} ${url.pathname}` } });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-openai listening on ${port}`);
});
NODE

MOCK_PORT="$MOCK_PORT" \
MOCK_REQUEST_LOG="$MOCK_REQUEST_LOG" \
SUCCESS_MARKER="$SUCCESS_MARKER" \
RAW_SCHEMA_ERROR="$RAW_SCHEMA_ERROR" \
node /tmp/openclaw-openai-web-search-minimal-mock.mjs >/tmp/openclaw-openai-web-search-minimal-mock.log 2>&1 &
mock_pid="$!"

for _ in $(seq 1 80); do
  if node -e "fetch('http://127.0.0.1:${MOCK_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
node -e "fetch('http://127.0.0.1:${MOCK_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null

node "$entry" gateway --port "$PORT" --bind lan --allow-unconfigured >"$GATEWAY_LOG" 2>&1 &
gateway_pid="$!"
for _ in $(seq 1 360); do
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    echo "gateway exited before listening" >&2
    exit 1
  fi
  if node --input-type=module -e "
    import net from 'node:net';
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(process.env.PORT) });
    const timeout = setTimeout(() => { socket.destroy(); process.exit(1); }, 400);
    socket.on('connect', () => { clearTimeout(timeout); socket.end(); process.exit(0); });
    socket.on('error', () => { clearTimeout(timeout); process.exit(1); });
  " >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
node --input-type=module -e "
  import net from 'node:net';
  const socket = net.createConnection({ host: '127.0.0.1', port: Number(process.env.PORT) });
  const timeout = setTimeout(() => { socket.destroy(); process.exit(1); }, 1000);
  socket.on('connect', () => { clearTimeout(timeout); socket.end(); process.exit(0); });
  socket.on('error', () => { clearTimeout(timeout); process.exit(1); });
" >/dev/null

cat >/tmp/openclaw-openai-web-search-minimal-client.mjs <<'NODE'
const PROTOCOL_VERSION = 3;
const port = process.env.PORT;
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const mode = process.argv[2];
const message =
  mode === "reject"
    ? "FORCE_SCHEMA_REJECT"
    : "Return exactly OPENCLAW_SCHEMA_E2E_OK.";
const id = mode === "reject" ? "schema-reject" : "schema-success";

if (!port || !token) throw new Error("missing PORT/OPENCLAW_GATEWAY_TOKEN");

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("ws open timeout")), 5000);
  ws.addEventListener("open", () => {
    clearTimeout(t);
    resolve();
  }, { once: true });
});

function onceFrame(filter, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for frame")), timeoutMs);
    const handler = (event) => {
      const obj = JSON.parse(String(event.data));
      if (!filter(obj)) return;
      clearTimeout(t);
      ws.removeEventListener("message", handler);
      resolve(obj);
    };
    ws.addEventListener("message", handler);
  });
}

ws.send(JSON.stringify({
  type: "req",
  id: "connect",
  method: "connect",
  params: {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: `openai-web-search-minimal-${mode}`,
      version: "dev",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: ["tool-events"],
    auth: { token },
  },
}));
const connectRes = await onceFrame((o) => o?.type === "res" && o?.id === "connect");
if (!connectRes.ok) throw new Error(`connect failed: ${connectRes.error?.message ?? "unknown"}`);

ws.send(JSON.stringify({
  type: "req",
  id,
  method: "chat.send",
  params: {
    sessionKey: "agent:main:main",
    message,
    thinking: "minimal",
    deliver: false,
    timeoutMs: 30000,
    idempotencyKey: id,
  },
}));
const sendRes = await onceFrame((o) => o?.type === "res" && o?.id === id);
if (!sendRes.ok) throw new Error(`chat.send failed: ${sendRes.error?.message ?? "unknown"}`);

if (mode === "reject") {
  ws.close();
  process.exit(0);
}

const terminal = await onceFrame(
  (o) =>
    o?.type === "event" &&
    o?.event === "chat" &&
    o?.payload?.runId === id &&
    (o?.payload?.state === "final" || o?.payload?.state === "error"),
  45000,
);
ws.close();

if (mode === "success" && terminal.payload?.state !== "final") {
  throw new Error(`expected final success event, got ${JSON.stringify(terminal)}`);
}
NODE

PORT="$PORT" OPENCLAW_GATEWAY_TOKEN="$TOKEN" node /tmp/openclaw-openai-web-search-minimal-client.mjs success >/tmp/openclaw-openai-web-search-minimal-client-success.log 2>&1

node - "$MOCK_REQUEST_LOG" <<'NODE'
const fs = require("node:fs");
const logPath = process.argv[2];
const entries = fs.readFileSync(logPath, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
const responseEntries = entries.filter((entry) => entry.path === "/v1/responses");
if (responseEntries.length < 1) {
  throw new Error(`mock OpenAI /v1/responses was not used. Requests: ${JSON.stringify(entries)}`);
}
const success = responseEntries.find((entry) => JSON.stringify(entry.body).includes("OPENCLAW_SCHEMA_E2E_OK"));
if (!success) {
  throw new Error(`missing success request. Requests: ${JSON.stringify(responseEntries)}`);
}
const tools = Array.isArray(success.body.tools) ? success.body.tools : [];
const hasWebSearch = tools.some((tool) => tool?.type === "web_search" || (tool?.type === "function" && (tool?.name === "web_search" || tool?.function?.name === "web_search")));
if (!hasWebSearch) {
  throw new Error(`success request did not include web_search. Body: ${JSON.stringify(success.body)}`);
}
if (success.body.reasoning?.effort !== "low") {
  throw new Error(`expected reasoning.effort low with web_search, got ${JSON.stringify(success.body.reasoning)}`);
}
NODE

PORT="$PORT" OPENCLAW_GATEWAY_TOKEN="$TOKEN" node /tmp/openclaw-openai-web-search-minimal-client.mjs reject >/tmp/openclaw-openai-web-search-minimal-client-reject.log 2>&1

for _ in $(seq 1 80); do
  if grep -Fq "$RAW_SCHEMA_ERROR" "$GATEWAY_LOG"; then
    break
  fi
  sleep 0.25
done
grep -F "$RAW_SCHEMA_ERROR" "$GATEWAY_LOG" >/dev/null

echo "OpenAI web_search minimal reasoning Docker E2E passed"
EOF
