import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.ts";

// Leave time inside the harness's 120 s budget for after hooks to join children.
const TEST_TIMEOUT_MS = 90_000;

function run(context, children, command, args, options) {
  context.signal.throwIfAborted();
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve) => {
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  children.add({ child, closed });
  return new Promise((resolve, reject) => {
    const abort = () => {
      const error = new Error(
        `Child did not finish before the test ended:\n${stderr.slice(-4000)}`,
        {
          cause: context.signal.reason,
        },
      );
      context.diagnostic(error.message);
      reject(error);
    };
    context.signal.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    closed.then(resolve).finally(() => context.signal.removeEventListener("abort", abort));
  });
}

// A descendant can hold the pipes after its parent exits, so always kill the group.
async function stopChildren(children) {
  for (const { child } of children) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH" && error.code !== "EPERM") {
          throw error;
        }
      }
    }
  }
  await Promise.all([...children].map(({ closed }) => closed));
}

// The 90 s / 60 s budgets bound live runs and are not under test here.
const frozenClock = "data:text/javascript,const t=performance.now();performance.now=()=>t;";
const checkpointPath = fileURLToPath(new URL("./telegram-binding-checkpoint.mjs", import.meta.url));
const sourceRoot = fs.realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
const runId = "upgrade-proof";
const chatId = "-1001234567890";
const topicId = 42;
const parentKey = `agent:main:telegram:group:${chatId}:topic:${topicId}`;
const childKey = "agent:main:subagent:worker";
const toolCallId = "call_mock_sessions_spawn_0123456789|fc_fixture";
const baselineCommit = "a".repeat(40);
const candidateCommit = "b".repeat(40);

// Installed Gateway stand-in: answers the checkpoint's read-only RPCs from a transcript file.
const fakeEntry = `import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const method = args[2];
const params = JSON.parse(args[args.indexOf("--params") + 1]);
const state = JSON.parse(readFileSync(process.env.CHECKPOINT_TEST_TRANSCRIPTS, "utf8"));
const session = params.key === state.childKey ? "child" : params.key === state.parentKey ? "parent" : undefined;
const result =
  method === "sessions.describe"
    ? { session: session === "child" ? { key: params.key, sessionId: "child-session" } : undefined }
    : { messages: state[session] };
console.log(JSON.stringify(result));
`;

let seq = 0;
const stamp = (message) => ({
  ...message,
  __openclaw: { id: `m${++seq}`, seq },
  timestamp: 1_700_000_000_000 + seq,
});
const user = (value) => stamp({ role: "user", content: [{ type: "text", text: value }] });
const assistant = (value) => stamp({ role: "assistant", content: [{ type: "text", text: value }] });
const ack = (name) => assistant(`TELEGRAM_BINDING_ACK_${name}_${runId}`);
const turn = (name) => [user(`@sut TELEGRAM_BINDING_${name}_${runId}.`), ack(name)];

function spawnTranscripts() {
  const args = {
    task: `TELEGRAM_BINDING_CHILD_${runId}. Reply with the child fixture acknowledgment.`,
    taskName: `telegram-binding-${runId}`,
    runtime: "subagent",
    thread: true,
    mode: "session",
    cleanup: "keep",
    context: "isolated",
  };
  return {
    parentKey,
    childKey,
    parent: [
      user(`@sut TELEGRAM_BINDING_SPAWN_${runId}.`),
      stamp({
        role: "assistant",
        content: [{ type: "toolCall", name: "sessions_spawn", id: toolCallId, arguments: args }],
      }),
      stamp({
        role: "toolResult",
        toolName: "sessions_spawn",
        toolCallId,
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "accepted",
              taskName: args.taskName,
              mode: "session",
              context: "isolated",
              childSessionKey: childKey,
            }),
          },
        ],
      }),
      ack("PARENT"),
    ],
    child: [user(args.task), ack("CHILD")],
  };
}

function createRun(context) {
  const children = new Set();
  const temporary = useAutoCleanupTempDirTracker((cleanup) =>
    context.after(async () => {
      await stopChildren(children);
      cleanup();
    }),
  );
  const owned = temporary.make("openclaw-tg-user-mock-sut-");
  const proof = path.join(owned, "proof");
  const packageRoot = path.join(owned, "package");
  fs.mkdirSync(path.join(packageRoot, "dist/plugin-sdk"), { recursive: true });
  fs.mkdirSync(path.join(owned, "state"));
  fs.mkdirSync(proof);
  fs.writeFileSync(path.join(packageRoot, "dist/entry.js"), fakeEntry);
  fs.writeFileSync(
    path.join(packageRoot, "dist/plugin-sdk/logging-core.js"),
    "export const redactSensitiveText = (value) => value;\n",
  );
  const buildInfo = (commit) => ({ buildId: "fixture-build", commit });
  fs.writeFileSync(path.join(packageRoot, "dist/build-info.json"), JSON.stringify(buildInfo()));
  const runtimeHashes = {
    "dist/entry.js": createHash("sha256").update(fakeEntry).digest("hex"),
  };
  fs.writeFileSync(
    path.join(proof, "upgrade-input.json"),
    JSON.stringify({
      packageRoot,
      baseline: { buildInfo: buildInfo(baselineCommit), runtimeHashes },
      candidate: { buildInfo: buildInfo(candidateCommit), runtimeHashes },
    }),
  );
  const eventsPath = path.join(proof, "events.ndjson");
  fs.writeFileSync(
    path.join(proof, "fixture.json"),
    JSON.stringify({ runId, chatId, topicId, eventsPath }),
  );
  fs.writeFileSync(
    path.join(owned, "config.json"),
    JSON.stringify({ gateway: { port: 18789, bind: "loopback", auth: { mode: "none" } } }),
  );
  let elapsedMs = 0;
  const events = [];
  const transcriptsPath = path.join(owned, "transcripts.json");
  return {
    proof,
    // Native readiness: each marker send is followed by its SUT ack in the same forum topic.
    observe(trigger, acks) {
      events.push({
        kind: "action",
        actionType: "send",
        status: "completed",
        text: `@sut TELEGRAM_BINDING_${trigger}_${runId}.`,
        elapsedMs: ++elapsedMs,
      });
      for (const name of acks) {
        events.push({
          kind: "message",
          isSut: true,
          text: `TELEGRAM_BINDING_ACK_${name}_${runId}`,
          elapsedMs: ++elapsedMs,
          topicType: "messageTopicForum",
          topicId,
          raw: { message: { chat_id: Number(chatId) } },
        });
      }
      fs.writeFileSync(eventsPath, events.map((event) => JSON.stringify(event) + "\n").join(""));
    },
    async checkpoint(phase, transcripts) {
      fs.writeFileSync(transcriptsPath, JSON.stringify(transcripts));
      fs.writeFileSync(
        path.join(proof, "installed-runtime.json"),
        JSON.stringify({
          packageRoot: fs.realpathSync(packageRoot),
          build: buildInfo(phase === "spawn" ? baselineCommit : candidateCommit),
        }),
      );
      const output = path.join(proof, `routing-${phase}.json`);
      const previous = { before: "spawn", after: "before" }[phase];
      const child = await run(
        context,
        children,
        process.execPath,
        [
          `--import=${frozenClock}`,
          checkpointPath,
          phase,
          parentKey,
          runId,
          output,
          sourceRoot,
          ...(previous ? [path.join(proof, `routing-${previous}.json`)] : []),
        ],
        {
          cwd: sourceRoot,
          env: {
            PATH: process.env.PATH,
            OPENCLAW_CONFIG_PATH: path.join(owned, "config.json"),
            OPENCLAW_STATE_DIR: path.join(owned, "state"),
            TELEGRAM_E2E_TEST_API_ROOT: "http://127.0.0.1:9",
            CHECKPOINT_TEST_TRANSCRIPTS: transcriptsPath,
          },
        },
      );
      const diagnostic = JSON.parse(fs.readFileSync(`${output}.diagnostic.json`, "utf8"));
      return {
        exitCode: child.status,
        diagnostic,
        checkpoint: child.status === 0 ? JSON.parse(fs.readFileSync(output, "utf8")) : undefined,
      };
    },
  };
}

describe("Telegram binding checkpoints", { concurrency: true }, () => {
  test(
    "candidate checkpoints require follow-ups in the parent topic session after a legacy takeover",
    { timeout: TEST_TIMEOUT_MS },
    async (context) => {
      const fixture = createRun(context);
      const transcripts = spawnTranscripts();
      fixture.observe("SPAWN", ["PARENT", "CHILD"]);
      const spawned = await fixture.checkpoint("spawn", transcripts);
      assert.equal(spawned.exitCode, 0, JSON.stringify(spawned.diagnostic));
      assert.equal(spawned.checkpoint.phases.CHILD.session, "child");

      fixture.observe("BEFORE", ["BEFORE"]);
      transcripts.parent.push(...turn("BEFORE"));
      const before = await fixture.checkpoint("before", transcripts);
      assert.equal(before.exitCode, 0, JSON.stringify(before.diagnostic));
      assert.equal(before.checkpoint.childKey, childKey);
      assert.equal(before.checkpoint.phases.CHILD.session, "child");
      assert.equal(before.checkpoint.phases.BEFORE.session, "parent");

      fixture.observe("AFTER", ["AFTER"]);
      transcripts.parent.push(...turn("AFTER"));
      const after = await fixture.checkpoint("after", transcripts);
      assert.equal(after.exitCode, 0, JSON.stringify(after.diagnostic));
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(after.checkpoint.phases).map(([name, fact]) => [name, fact.session]),
        ),
        { CHILD: "child", BEFORE: "parent", AFTER: "parent" },
      );
    },
  );

  test(
    "candidate checkpoints reject a follow-up still routed to the legacy spawned child",
    { timeout: TEST_TIMEOUT_MS },
    async (context) => {
      const fixture = createRun(context);
      const transcripts = spawnTranscripts();
      fixture.observe("SPAWN", ["PARENT", "CHILD"]);
      assert.equal((await fixture.checkpoint("spawn", transcripts)).exitCode, 0);

      fixture.observe("BEFORE", ["BEFORE"]);
      transcripts.child.push(...turn("BEFORE"));
      const before = await fixture.checkpoint("before", transcripts);
      assert.equal(before.exitCode, 1);
      assert.equal(before.diagnostic.code, "FOLLOWUP_ROUTED_TO_CHILD");
      assert.equal(before.diagnostic.earlyPhase, "BEFORE");
    },
  );

  test(
    "candidate checkpoints reject a removed spawn-phase child transcript",
    { timeout: TEST_TIMEOUT_MS },
    async (context) => {
      const fixture = createRun(context);
      const transcripts = spawnTranscripts();
      fixture.observe("SPAWN", ["PARENT", "CHILD"]);
      assert.equal((await fixture.checkpoint("spawn", transcripts)).exitCode, 0);

      fixture.observe("BEFORE", ["BEFORE"]);
      transcripts.parent.push(...turn("BEFORE"));
      transcripts.child = [];
      const before = await fixture.checkpoint("before", transcripts);
      assert.equal(before.exitCode, 1);
      assert.equal(before.diagnostic.code, "PRIOR_CHILD_PHASE_DISAPPEARED");
    },
  );
});
