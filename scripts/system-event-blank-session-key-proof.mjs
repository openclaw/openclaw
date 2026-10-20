#!/usr/bin/env node
// Shipped CLI proof: blank system-event --session-key rejects before wake.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BLANK_ERROR = "--session-key must not be blank";
const VALID_SESSION_KEY = "agent:proof:cli";
const TOKEN = "proof-session-key-token";
const CASE_TIMEOUT_MS = 120_000;

const distEntry = ["dist/entry.js", "dist/entry.mjs"].find((relative) =>
  existsSync(path.join(root, relative)),
);
const cliInvocation = distEntry
  ? { label: "node openclaw.mjs", args: ["openclaw.mjs"] }
  : {
      label: "node --import ./scripts/tsx.mjs src/entry.ts",
      args: ["--import", "./scripts/tsx.mjs", "src/entry.ts"],
    };

function stripAnsi(text) {
  const escape = String.fromCharCode(0x1b);
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === escape && text[index + 1] === "[") {
      index += 2;
      while (index < text.length && text[index] !== "m") {
        index += 1;
      }
      continue;
    }
    out += text[index];
  }
  return out;
}

function redact(text, secrets) {
  let redacted = text;
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.replaceAll(secret, "<redacted>");
    }
  }
  return stripAnsi(redacted);
}

function messageText(data) {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.filter((part) => Buffer.isBuffer(part))).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return "";
}

function publicWakeParams(params) {
  const wake = {};
  if (typeof params.mode === "string") {
    wake.mode = params.mode;
  }
  if (typeof params.text === "string") {
    wake.text = params.text;
  }
  if (typeof params.sessionKey === "string") {
    wake.sessionKey = params.sessionKey;
  }
  return wake;
}

function startRecorder() {
  const calls = [];
  const httpServer = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const sockets = new WebSocketServer({ server: httpServer });
  sockets.on("connection", (socket) => {
    calls.push({ kind: "connection" });
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "blank-session-key-proof", ts: Date.now() },
      }),
    );
    socket.on("message", (data) => {
      let request;
      try {
        request = JSON.parse(messageText(data));
      } catch {
        return;
      }
      if (request?.type !== "req" || typeof request.id !== "string") {
        return;
      }
      const method = typeof request.method === "string" ? request.method : "";
      const params = request.params && typeof request.params === "object" ? request.params : {};
      calls.push({
        kind: "rpc",
        method,
        params: method === "wake" ? publicWakeParams(params) : { redacted: true },
      });
      const payload =
        method === "connect"
          ? {
              type: "hello-ok",
              protocol: 4,
              server: { version: "proof", connId: "blank-session-key-proof" },
              features: { methods: ["wake"], events: ["connect.challenge"] },
              snapshot: {},
              auth: {
                role: "operator",
                scopes: ["operator.read", "operator.write", "operator.admin"],
              },
              policy: {
                maxPayload: 1_000_000,
                maxBufferedBytes: 1_000_000,
                tickIntervalMs: 60_000,
              },
            }
          : { ok: true };
      socket.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload }));
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("recorder did not bind a loopback port"));
        return;
      }
      resolve({
        url: `ws://127.0.0.1:${address.port}`,
        calls,
        reset() {
          calls.length = 0;
        },
        close() {
          for (const client of sockets.clients) {
            client.terminate();
          }
          return new Promise((done) => {
            httpServer.close(() => done());
          });
        },
      });
    });
  });
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, CASE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

function wakeCalls(calls) {
  return calls.filter((call) => call.kind === "rpc" && call.method === "wake");
}

function selectorMatches(calls, sessionKey) {
  const wakes = wakeCalls(calls);
  if (wakes.length !== 1) {
    return false;
  }
  const params = wakes[0].params;
  if (params.mode !== "next-heartbeat" || params.text !== "ping") {
    return false;
  }
  if (sessionKey === undefined) {
    return !Object.hasOwn(params, "sessionKey");
  }
  return params.sessionKey === sessionKey;
}

function formatCase(name, command, result, secrets) {
  const lines = [
    `--- ${name} ---`,
    `command: ${command}`,
    `exit: ${result.signal ? `signal ${result.signal}` : result.exitCode}`,
    `gatewayCalls: ${result.calls.length}`,
    `wake: ${JSON.stringify(wakeCalls(result.calls).map((call) => call.params))}`,
    "stdout:",
    redact(result.stdout, secrets).trimEnd() || "<empty>",
    "stderr:",
    redact(result.stderr, secrets).trimEnd() || "<empty>",
    "",
  ];
  return lines.join("\n");
}

const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-blank-session-key-"));
const configPath = path.join(stateDir, "openclaw.json");
await writeFile(configPath, "{}\n");
const recorder = await startRecorder();
const secrets = [TOKEN, stateDir, configPath, process.env.HOME, process.env.USERPROFILE];
const env = {
  PATH: process.env.PATH ?? "",
  HOME: stateDir,
  USERPROFILE: stateDir,
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  LANG: process.env.LANG ?? "C.UTF-8",
  NO_COLOR: "1",
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};
const baseArgs = [
  ...cliInvocation.args,
  "system",
  "event",
  "--text",
  "ping",
  "--url",
  recorder.url,
  "--token",
  TOKEN,
  "--timeout",
  "8000",
];

const cases = [
  {
    name: "blank-human",
    args: ["--session-key", "   "],
    command: "system event --text ping --session-key '   '",
    pass(result) {
      const output = `${result.stdout}\n${result.stderr}`;
      return result.exitCode !== 0 && output.includes(BLANK_ERROR) && result.calls.length === 0;
    },
  },
  {
    name: "blank-json",
    args: ["--session-key", "   ", "--json"],
    command: "system event --text ping --session-key '   ' --json",
    pass(result) {
      const output = `${result.stdout}\n${result.stderr}`;
      return result.exitCode !== 0 && output.includes(BLANK_ERROR) && result.calls.length === 0;
    },
  },
  {
    name: "omitted-session-key",
    args: [],
    command: "system event --text ping",
    pass(result) {
      return selectorMatches(result.calls, undefined);
    },
  },
  {
    name: "valid-session-key",
    args: ["--session-key", VALID_SESSION_KEY],
    command: `system event --text ping --session-key ${VALID_SESSION_KEY}`,
    pass(result) {
      return selectorMatches(result.calls, VALID_SESSION_KEY);
    },
  },
];

const transcript = [
  "system event blank --session-key proof",
  `entry: ${cliInvocation.label}`,
  distEntry
    ? `dist: ${distEntry}`
    : "dist: absent; src/entry.ts is the register path openclaw.mjs loads from dist/entry.js",
  `recorder: ${recorder.url}`,
  "",
];
let failed = false;
try {
  for (const testCase of cases) {
    recorder.reset();
    const result = await runCli([...baseArgs, ...testCase.args], env);
    result.calls = recorder.calls.slice();
    const passed = testCase.pass(result);
    failed ||= !passed;
    transcript.push(formatCase(testCase.name, testCase.command, result, secrets));
    transcript.push(`pass: ${passed}`);
    transcript.push("");
  }
} finally {
  await recorder.close();
  await rm(stateDir, { recursive: true, force: true });
}

transcript.push(failed ? "blank-reject: fail" : "blank-reject: pass");
process.stdout.write(`${transcript.join("\n")}\n`);
process.exitCode = failed ? 1 : 0;
