type LogLevelName = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

const LOG_FILE = "/tmp/openclaw/openclaw-gateway.log";

const ENTRIES: ReadonlyArray<readonly [LogLevelName, string, string]> = [
  ["INFO", "gateway", "Gateway listening on 127.0.0.1:18789 with 3 channels and 12 plugins."],
  [
    "INFO",
    "gateway/ws",
    "client connected conn=4f2a role=operator scopes=operator.read,operator.write",
  ],
  ["DEBUG", "gateway/ws", "⇄ res ✓ sessions.list 42ms conn=4f2a"],
  ["TRACE", "agents/runtime", "lane main: queue depth 0, active 1, draining next turn"],
  [
    "INFO",
    "agents/runtime",
    "run started session=agent:main:main model=example/model-large thinking=medium",
  ],
  [
    "DEBUG",
    "agents/tools",
    "tool call read path=docs/release-checklist.md bytes=18234 elapsed=12ms",
  ],
  [
    "DEBUG",
    "agents/tools",
    'tool call exec command="pnpm test --filter ui" cwd=/workspace/project timeout=120000',
  ],
  [
    "WARN",
    "agents/tools",
    "exec output truncated at 200000 bytes; the transcript keeps the first and last 50000 bytes",
  ],
  ["INFO", "channels/telegram", "inbound message accepted chat=ops-room thread=none attachments=1"],
  [
    "WARN",
    "channels/telegram",
    "send retry 2/5 after 429 Too Many Requests; waiting 3s before the next attempt",
  ],
  [
    "ERROR",
    "channels/slack",
    "socket mode disconnected: pong timeout after 30000ms; reconnecting with backoff 4s",
  ],
  ["INFO", "channels/slack", "socket mode reconnected after 4312ms"],
  ["DEBUG", "cron", "next wake in 842s for job morning-briefing (0 8 * * *, America/Sao_Paulo)"],
  [
    "INFO",
    "cron",
    "job finished id=morning-briefing status=ok durationMs=48213 deliveredTo=telegram:ops-room",
  ],
  [
    "ERROR",
    "cron",
    "job failed id=sync-calendar attempt=2: upstream returned 503 Service Unavailable",
  ],
  ["DEBUG", "plugins", "plugin loaded id=browser version=2026.11.1 hooks=4 tools=9 elapsedMs=128"],
  [
    "WARN",
    "plugins",
    "plugin id=legacy-notes declares a deprecated manifest field: configSchema.uiHints",
  ],
  [
    "TRACE",
    "memory/sync",
    "embedding batch 14/40 size=64 provider=example-embeddings elapsedMs=311",
  ],
  ["INFO", "memory/sync", "index refreshed files=1284 chunks=9612 durationMs=7421"],
  ["WARN", "gateway/auth", "rejected pairing request from 192.0.2.44: device code expired 42s ago"],
  [
    "ERROR",
    "agents/runtime",
    "provider stream ended before the final message: ECONNRESET at https://api.example.com/v1/responses; retrying with the fallback model example/model-small",
  ],
  [
    "FATAL",
    "gateway/canvas",
    "canvas host failed to bind 127.0.0.1:18793: EADDRINUSE; canvas tools stay unavailable until the Gateway restarts",
  ],
  ["DEBUG", "gateway/ws", "⇄ res ✓ logs.tail 6ms conn=4f2a cursor=1048576 bytes=0"],
  [
    "INFO",
    "agents/runtime",
    "run finished session=agent:main:main durationMs=91234 inputTokens=18234 outputTokens=2210",
  ],
];

/** Gateway-formatted file log lines, followed by empty tails once the page holds a cursor. */
export function buildLogsTailMock(now = Date.now()) {
  const lines = Array.from({ length: 3 }, () => ENTRIES)
    .flat()
    .map(([level, subsystem, message], index, all) => {
      const name = JSON.stringify({ subsystem });
      return JSON.stringify({
        "0": name,
        "1": message,
        _meta: { logLevelName: level, name },
        time: new Date(now - (all.length - index) * 47_000).toISOString(),
        hostname: "gateway-host",
        message,
      });
    });
  const cursor = lines.reduce((total, line) => total + line.length + 1, 0);
  const tail = { cursor, file: LOG_FILE, size: cursor };
  return {
    cases: [
      { match: { cursor }, response: { ...tail, lines: [] } },
      { response: { ...tail, lines, reset: true } },
    ],
  };
}
