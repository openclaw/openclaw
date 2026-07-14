import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve(".agents/skills/agent-transcript/scripts/agent-transcript");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-transcript-test-"));
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function run(args, options = {}) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    ...options,
  });
}

function writeFakeCodex(dir) {
  const script = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(
    script,
    `import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) {
    if (process.env.FAKE_CODEX_OVERSIZE === "stdout") {
      process.stdout.write("x".repeat(21 * 1024 * 1024));
      return;
    }
    if (process.env.FAKE_CODEX_OVERSIZE === "stderr") {
      process.stderr.write("x".repeat(21 * 1024 * 1024));
      return;
    }
    console.log(JSON.stringify({ id: 1, result: {} }));
  } else if (message.id === 2) {
    console.log(JSON.stringify({ id: 2, error: { code: -32600, message: "thread not loaded" } }));
  } else if (message.id === 3) {
    if (
      message.params.path !== process.env.FAKE_EXPECTED_ROLLOUT_PATH ||
      message.params.threadId !== "11111111-2222-4333-8444-555555555555"
    ) {
      console.log(JSON.stringify({ id: 3, error: { code: -32602, message: "missing resume path or thread id" } }));
      return;
    }
    console.log(JSON.stringify({
      id: 3,
      result: {
        thread: {
          turns: [{ items: [
            { type: "userMessage", content: [{ type: "text", text: "Scoped request." }] },
            { type: "agentMessage", text: "Scoped response." }
          ] }]
        }
      }
    }));
  }
});
`,
  );
  const posix = path.join(dir, "codex");
  fs.writeFileSync(posix, `#!/bin/sh\nexec node "$(dirname "$0")/fake-codex.mjs" "$@"\n`);
  fs.chmodSync(posix, 0o755);
  fs.writeFileSync(path.join(dir, "codex.cmd"), `@node "%~dp0\\fake-codex.mjs" %*\r\n`);
  return script;
}

test("render redacts common secrets and local identifiers", () => {
  const dir = tempDir();
  const session = path.join(dir, "session.jsonl");
  writeJsonl(session, [
    {
      type: "response_item",
      payload: {
        role: "user",
        content: [
          {
            type: "text",
            text: "Use /Users/ahmed/project, email person@example.com, and header Bearer abcdefghijklmnopqrstuvwxyz123456.",
          },
        ],
      },
    },
    {
      type: "response_item",
      payload: { role: "assistant", content: [{ type: "text", text: "Done." }] },
    },
  ]);

  const output = run(["render", "--session", session]);
  assert.match(output, /\[LOCAL_PATH\]/);
  assert.match(output, /\[REDACTED_EMAIL\]/);
  assert.match(output, /\[REDACTED_AUTH_HEADER\]/);
  assert.doesNotMatch(output, /person@example\.com/);
  assert.doesNotMatch(output, /abcdefghijklmnopqrstuvwxyz123456/);
});

test("render drops raw tool outputs but keeps a compact tool summary", () => {
  const dir = tempDir();
  const session = path.join(dir, "session.jsonl");
  writeJsonl(session, [
    {
      type: "response_item",
      payload: { role: "user", content: [{ type: "text", text: "Run tests." }] },
    },
    {
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", arguments: "npm test" },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: "raw output with sk-abcdefghijklmnopqrstuvwxyz123456",
      },
    },
  ]);

  const output = run(["render", "--session", session]);
  assert.match(output, /tool summary/);
  assert.match(output, /1 execute/);
  assert.doesNotMatch(output, /raw output/);
  assert.doesNotMatch(output, /sk-abcdefghijklmnopqrstuvwxyz123456/);
});

test("append-body replaces an existing transcript section", () => {
  const dir = tempDir();
  const session = path.join(dir, "session.jsonl");
  const body = path.join(dir, "body.md");
  writeJsonl(session, [
    {
      type: "response_item",
      payload: { role: "user", content: [{ type: "text", text: "New scoped work." }] },
    },
    {
      type: "response_item",
      payload: { role: "assistant", content: [{ type: "text", text: "Implemented." }] },
    },
  ]);
  fs.writeFileSync(
    body,
    "# PR\n\n<!-- agent-transcript:start -->\nold transcript\n<!-- agent-transcript:end -->\n",
  );

  const output = run(["append-body", "--body", body, "--session", session]);
  assert.match(output, /# PR/);
  assert.match(output, /New scoped work/);
  assert.doesNotMatch(output, /old transcript/);
  assert.equal((output.match(/agent-transcript:start/g) || []).length, 1);
});

test("app-server rendering resumes a persisted thread when thread/read is not loaded", () => {
  const dir = tempDir();
  const session = path.join(dir, "11111111-2222-4333-8444-555555555555.jsonl");
  writeJsonl(session, []);
  const fakeCodex = writeFakeCodex(dir);

  const output = run(["render", "--session", session, "--app-server"], {
    env: {
      ...process.env,
      AGENT_TRANSCRIPT_CODEX_BIN: process.execPath,
      AGENT_TRANSCRIPT_CODEX_PREFIX_ARGS: JSON.stringify([fakeCodex]),
      FAKE_EXPECTED_ROLLOUT_PATH: path.resolve(session),
    },
  });

  assert.match(output, /codex app-server thread\/read or thread\/resume with turns/);
  assert.match(output, /Scoped request\./);
  assert.match(output, /Scoped response\./);
});

test("app-server rendering rejects oversized transport responses", () => {
  const dir = tempDir();
  const session = path.join(dir, "11111111-2222-4333-8444-555555555555.jsonl");
  writeJsonl(session, []);
  const fakeCodex = writeFakeCodex(dir);

  assert.throws(
    () =>
      run(["render", "--session", session, "--app-server"], {
        env: {
          ...process.env,
          AGENT_TRANSCRIPT_CODEX_BIN: process.execPath,
          AGENT_TRANSCRIPT_CODEX_PREFIX_ARGS: JSON.stringify([fakeCodex]),
          FAKE_CODEX_OVERSIZE: "stdout",
        },
      }),
    /app-server response exceeded 20971520 bytes/,
  );
});

test("app-server rendering rejects oversized stderr", () => {
  const dir = tempDir();
  const session = path.join(dir, "11111111-2222-4333-8444-555555555555.jsonl");
  writeJsonl(session, []);
  const fakeCodex = writeFakeCodex(dir);

  assert.throws(
    () =>
      run(["render", "--session", session, "--app-server"], {
        env: {
          ...process.env,
          AGENT_TRANSCRIPT_CODEX_BIN: process.execPath,
          AGENT_TRANSCRIPT_CODEX_PREFIX_ARGS: JSON.stringify([fakeCodex]),
          FAKE_CODEX_OVERSIZE: "stderr",
        },
      }),
    /app-server output exceeded 20971520 bytes/,
  );
});

test("find scans CLAUDE_CONFIG_DIR projects and labels them as Claude", () => {
  const dir = tempDir();
  const home = tempDir();
  const projectDir = path.join(dir, "projects", "-tmp-agent-transcript");
  fs.mkdirSync(projectDir, { recursive: true });
  const session = path.join(projectDir, "11111111-2222-4333-8444-555555555555.jsonl");
  writeJsonl(session, [
    { type: "user", message: { role: "user", content: "claude-config-dir-marker" } },
    { type: "assistant", message: { role: "assistant", content: "Done." } },
  ]);

  const output = run(
    ["find", "--query", "claude-config-dir-marker", "--since-days", "1", "--max-files", "20"],
    {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: `${dir}${path.sep}`,
      },
    },
  );
  const matches = JSON.parse(output);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].file, session);
  assert.equal(matches[0].agent, "claude");
});

test("find labels explicit roots under trailing-slash CLAUDE_CONFIG_DIR as Claude", () => {
  const dir = tempDir();
  const home = tempDir();
  const projectRoot = path.join(dir, "projects");
  const projectDir = path.join(projectRoot, "-tmp-agent-transcript");
  fs.mkdirSync(projectDir, { recursive: true });
  const session = path.join(projectDir, "22222222-3333-4444-8555-666666666666.jsonl");
  writeJsonl(session, [
    { type: "user", message: { role: "user", content: "claude-config-dir-explicit-root-marker" } },
    { type: "assistant", message: { role: "assistant", content: "Done." } },
  ]);

  const output = run(
    [
      "find",
      "--query",
      "claude-config-dir-explicit-root-marker",
      "--since-days",
      "1",
      "--max-files",
      "20",
      "--root",
      projectRoot,
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: `${dir}${path.sep}`,
      },
    },
  );
  const matches = JSON.parse(output);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].file, session);
  assert.equal(matches[0].agent, "claude");
});
