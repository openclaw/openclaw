#!/usr/bin/env node
// Proof capture for openclaw/openclaw#156636 (synthetic 128k context fallback).
//
// Runs ONLY against a patched scratch Gateway that a human has started and signed in.
// It never starts a Gateway, never writes config, and never sends a model turn unless
// --run-turn is given. Every captured byte passes through redact() before it is printed
// or written. Review the output file before posting it anywhere.
//
//   node scripts/proof/156636-gateway-proof.mjs --phase fresh    --session-key <key> [--model github-copilot/<id>]
//   node scripts/proof/156636-gateway-proof.mjs --phase existing --session-key <key> [--run-turn]
//   node scripts/proof/156636-gateway-proof.mjs --phase account  --session-key <key> --label before|after
//   node scripts/proof/156636-gateway-proof.mjs --self-test
//
// Options: --out <file> (default ./156636-proof-<phase>.md), --openclaw <bin> (default
// "openclaw"), --timeout <ms> (default 60000), --expect-url <ws-url> (passed through).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------------------
// Redaction. Conservative: when in doubt, redact. Order matters (URLs before hosts/IPs).
// ---------------------------------------------------------------------------------------
const PUBLIC_HOSTS = new Set(["api.githubcopilot.com", "github.com", "api.github.com"]);
const RULES = [
  // Bearer / authorization values and common token shapes.
  [
    /(authorization|bearer|cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|session[-_]?token)(["'\s:=]+)([^\s"',}]+)/gi,
    "$1$2<redacted-secret>",
  ],
  [/\bgh[opusr]_[A-Za-z0-9]{20,}\b/g, "<redacted-github-token>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<redacted-github-token>"],
  [/\btid=[^\s;"']+/g, "tid=<redacted-copilot-token>"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "<redacted-api-key>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<redacted-jwt>"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "<redacted-hex>"],
  // URLs: keep scheme + well-known public host only.
  [
    /\b(https?|wss?):\/\/([^\s/"'<>]+)([^\s"'<>]*)/gi,
    (_m, scheme, host) => {
      const bare = host
        .replace(/^[^@]*@/, "")
        .replace(/:\d+$/, "")
        .toLowerCase();
      return PUBLIC_HOSTS.has(bare)
        ? `${scheme}://${bare}/<path>`
        : `${scheme}://<private-endpoint>`;
    },
  ],
  // IP addresses (v4, v6) and host:port.
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<redacted-ip>"],
  [/\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b/g, "<redacted-ip>"],
  [
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ts\.net|local|lan|internal|home|corp|intra)\b/gi,
    "<private-host>",
  ],
  // Email addresses and phone numbers (E.164 and common grouped formats).
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<redacted-email>"],
  [
    /(?<![\w.])\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?![\w.])/g,
    "<redacted-phone>",
  ],
  // Local filesystem paths and user names.
  [/(?:\/home|\/Users|\/root)\/[^\s"'`]+/g, "<redacted-path>"],
  [/[A-Za-z]:\\Users\\[^\s"'`]+/g, "<redacted-path>"],
  // Identifiers that tie output to a person or account.
  [
    /\b(account[-_]?id|user[-_]?id|profile[-_]?id|login|sessionId|session_id|chat[-_]?id|sender[-_]?id)(["'\s:=]+)([^\s"',}]+)/gi,
    "$1$2<redacted-id>",
  ],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<redacted-uuid>"],
];
export function redact(text) {
  let out = String(text);
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Session keys contain channel peers (phone numbers, chat ids). Report a stable alias.
function aliasSessionKey(key) {
  const [agent = "agent", id = "main"] = String(key).split(":");
  return `${agent}:${id}:<redacted-peer>`;
}

// Only these fields leave the process from structured responses.
const SESSION_FIELDS = [
  "modelProvider",
  "model",
  "agentHarnessId",
  "contextTokens",
  "contextTokensSource",
  "totalTokens",
  "modelSelectionLocked",
];
function pickSession(value) {
  const row = value?.session ?? value?.row ?? value;
  if (!row || typeof row !== "object") {
    return {};
  }
  return Object.fromEntries(SESSION_FIELDS.filter((k) => k in row).map((k) => [k, row[k]]));
}
function contextLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => /context|model|runtime|harness|auth/i.test(line))
    .map(redact);
}

// ---------------------------------------------------------------------------------------
// Gateway access through the documented CLI RPC helper (no raw sockets, no credentials).
// ---------------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { timeout: 60000, openclaw: "openclaw" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--phase") {
      args.phase = next();
    } else if (flag === "--session-key") {
      args.sessionKey = next();
    } else if (flag === "--model") {
      args.model = next();
    } else if (flag === "--label") {
      args.label = next();
    } else if (flag === "--out") {
      args.out = next();
    } else if (flag === "--openclaw") {
      args.openclaw = next();
    } else if (flag === "--timeout") {
      args.timeout = Number(next());
    } else if (flag === "--expect-url") {
      args.expectUrl = next();
    } else if (flag === "--run-turn") {
      args.runTurn = true;
    } else if (flag === "--self-test") {
      args.selfTest = true;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}
function call(args, method, params) {
  const argv = [
    "gateway",
    "call",
    method,
    "--json",
    "--params",
    JSON.stringify(params),
    "--timeout",
    String(args.timeout),
  ];
  if (args.expectUrl) {
    argv.push("--expect-url", args.expectUrl);
  }
  try {
    const raw = execFileSync(args.openclaw, argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return { ok: true, value: raw };
    }
  } catch (error) {
    return {
      ok: false,
      error: redact(String(error?.stderr || error?.message || error)).slice(0, 600),
    };
  }
}
function extractText(value) {
  if (typeof value === "string") {
    return value;
  }
  const parts = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node.text === "string") {
      parts.push(node.text);
    }
    for (const child of Object.values(node)) {
      if (child && typeof child === "object") {
        walk(child);
      }
    }
  };
  walk(value);
  return parts.join("\n");
}
function findStatusText(history) {
  const messages = history?.messages ?? history?.items ?? history ?? [];
  const texts = (Array.isArray(messages) ? messages : [])
    .map((m) =>
      typeof m?.text === "string"
        ? m.text
        : Array.isArray(m?.content)
          ? m.content.map((c) => c?.text ?? "").join("\n")
          : "",
    )
    .filter((t) => /Context/i.test(t));
  return texts.at(-1);
}
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function capture(args) {
  const key = args.sessionKey;
  const sections = [];
  const describe = call(args, "sessions.describe", { key });
  sections.push([
    "sessions.describe (selected fields)",
    describe.ok ? JSON.stringify(pickSession(describe.value), null, 2) : `error: ${describe.error}`,
  ]);

  const tool = call(args, "tools.invoke", {
    name: "session_status",
    sessionKey: key,
    idempotencyKey: randomUUID(),
  });
  const toolText = tool.ok ? extractText(tool.value) : `error: ${tool.error}`;
  sections.push([
    "session_status tool (context lines)",
    contextLines(toolText).join("\n") || "(no context line)",
  ]);

  const sent = call(args, "chat.send", {
    sessionKey: key,
    message: "/status",
    idempotencyKey: randomUUID(),
    deliver: false,
  });
  let statusText;
  if (sent.ok) {
    for (let attempt = 0; attempt < 10 && !statusText; attempt += 1) {
      await sleep(1000);
      const history = call(args, "chat.history", { sessionKey: key, limit: 6 });
      statusText = history.ok ? findStatusText(history.value) : undefined;
    }
  }
  sections.push([
    "/status (context lines)",
    sent.ok
      ? contextLines(statusText).join("\n") || "(status reply not observed)"
      : `error: ${sent.error}`,
  ]);
  return sections;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    return selfTest();
  }
  if (!["fresh", "existing", "account"].includes(args.phase)) {
    throw new Error("--phase must be fresh|existing|account");
  }
  if (!args.sessionKey) {
    throw new Error("--session-key is required");
  }
  const out = args.out ?? `156636-proof-${args.phase}${args.label ? `-${args.label}` : ""}.md`;
  const header = [
    `## ${args.phase}${args.label ? ` (${args.label})` : ""} — ${new Date().toISOString()}`,
    "",
    `- session: \`${aliasSessionKey(args.sessionKey)}\``,
    args.model ? `- selected model: \`${redact(args.model)}\`` : undefined,
  ].filter(Boolean);
  const blocks = [];
  if (args.model) {
    const patched = call(args, "sessions.patch", { key: args.sessionKey, model: args.model });
    blocks.push(["sessions.patch model", patched.ok ? "ok" : `error: ${patched.error}`]);
  }
  blocks.push(...(await capture(args)));
  if (args.runTurn) {
    const turn = call(args, "chat.send", {
      sessionKey: args.sessionKey,
      message: "Reply with the single word: ok",
      idempotencyKey: randomUUID(),
      deliver: false,
    });
    blocks.push(["ordinary run", turn.ok ? "accepted" : `error: ${turn.error}`]);
    await sleep(15000);
    blocks.push(...(await capture(args)).map(([title, body]) => [`after run: ${title}`, body]));
  }
  const body = [
    ...header,
    "",
    ...blocks.flatMap(([title, text]) => [`**${title}**`, "", "```text", redact(text), "```", ""]),
  ].join("\n");
  if (!existsSync(out)) {
    writeFileSync(out, "# #156636 gateway proof (redacted)\n\n");
  }
  appendFileSync(out, `${body}\n`);
  process.stdout.write(`${body}\nwrote ${out} — review before sharing\n`);
}

function selfTest() {
  const sample = [
    "Authorization: Bearer gho_abcdefghijklmnopqrstuvwxyz0123456789",
    "copilot token tid=abc123;exp=99;sku=x",
    "endpoint https://api.individual.githubcopilot.example/v1/models",
    "gateway ws://100.101.102.103:18789 and 192.168.1.20",
    "ipv6 fe80:0:0:0:200:f8ff:fe21:67cf",
    "peer +1 415 555 0134 and +491701234567",
    "host my-box.tailnet-1234.ts.net",
    "user alice@example.com at /home/alice/.openclaw/state",
    'accountId: "a-12345" sessionId=9f0c7c1e-5c1e-4b5f-9a38-7f1c0b8e2d11',
    "Context: 12k/872k (1%)",
  ].join("\n");
  const out = redact(sample);
  const leaks = [
    "gho_",
    "tid=abc",
    "githubcopilot.example",
    "100.101",
    "192.168",
    "fe80",
    "415 555",
    "491701",
    "ts.net",
    "alice",
    "a-12345",
    "9f0c7c1e",
  ].filter((s) => out.includes(s));
  const kept = out.includes("Context: 12k/872k (1%)");
  process.stdout.write(
    `${out}\n\nleaks: ${leaks.length ? leaks.join(", ") : "none"}; context line kept: ${kept}\n`,
  );
  if (leaks.length || !kept) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${redact(String(error?.message ?? error))}\n`);
    process.exitCode = 1;
  });
}
