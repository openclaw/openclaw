#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";

function log(value) {
  if (process.env.MUSE_REQUEST_LOG) {
    const line = typeof value === "string" ? value : JSON.stringify(value);
    appendFileSync(process.env.MUSE_REQUEST_LOG, `${line}\n`);
  }
}
log({
  event: "spawn",
  pid: process.pid,
  args: process.argv.slice(2),
  noAutoUpdate: process.env.MUSE_NO_AUTO_UPDATE,
  credentialBackend: process.env.TBH_CREDENTIAL_BACKEND,
  configHome: process.env.XDG_CONFIG_HOME,
  path: process.env.PATH,
  inheritedValue: process.env.MUSE_FIXTURE_INHERITED_VALUE,
});

let cursor = 0;
let sessionCount = 0;
let active;
let pendingNativeApproval = false;
let outboundBatch;
const sessions = new Map();
const send = (value) => {
  const line = `${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`;
  if (outboundBatch) {
    outboundBatch.push(line);
  } else {
    process.stdout.write(line);
  }
};
const reply = (id, result) => send({ id, result });
const reject = (id, code, message, kind) => send({ id, error: { code, message, data: { kind } } });
const accept = (id, params, extra = {}) =>
  reply(id, { commandId: params.commandId, status: "accepted", ...extra });
const event = (method, params) =>
  send({ method, params: { ...active, ...params, viewCursor: String(++cursor) } });
const sourceRange = { start: 0, end: 1 };
function item(kind, status, extra = {}) {
  const itemId = `${active.turnId}-${kind}`;
  const starting = status === "inProgress";
  event(starting ? "item/started" : "item/completed", {
    item: { itemId, turnId: active.turnId, kind, revision: starting ? 1 : 2, status, ...extra },
    ...(starting ? {} : { sourceRange }),
  });
  return itemId;
}
function complete(terminal, error) {
  log({ event: "terminal", terminal });
  event("turn/completed", { terminal, sourceRange, ...(error ? { error } : {}) });
}
const fail = (kind, message) => complete("failed", { kind, message, retryable: false });
function nativeApproval() {
  pendingNativeApproval = true;
  event("approval/requested", {
    approvalId: "native-approval",
    currentRequirementId: { approvalId: "native-approval", sourceIndex: 0 },
    availableChoices: [
      { choiceId: "native-allow", decision: "approved", scope: "once", label: "Allow" },
      { choiceId: "native-deny", decision: "denied", scope: "once", label: "Deny" },
    ],
    itemId: "native-tool",
    toolCallId: "native-tool",
    toolName: "bash",
    subject: { kind: "command", command: "work" },
    judgeEscalated: false,
    protectedWrite: false,
    taskId: "native-tool",
    sourceRange,
  });
}
function answer() {
  const itemId = item("reasoning", "inProgress", { text: "" });
  event("item/delta", { itemId, field: "summary.0", delta: "Considering" });
  item("reasoning", "completed", { text: "", summary: ["Considering"] });
  if (
    active.prompt === "tool" ||
    active.prompt === "tool-failure" ||
    active.prompt === "tool-replay"
  ) {
    if (active.prompt !== "tool-replay") {
      item("toolCall", "inProgress", {
        tool: "read_file",
        callId: "call-1",
        args: '{"path":"a.txt"}',
      });
    }
    const finish = () => {
      item("toolCall", active.prompt === "tool-failure" ? "failed" : "completed", {
        tool: "read_file",
        callId: "call-1",
        args: '{"path":"a.txt"}',
        visibleOutput: "file content",
      });
      answerText();
    };
    if (active.prompt === "tool" && process.env.MUSE_FIXTURE_TOOL_GATE_PORT) {
      const gate = createConnection({
        host: "127.0.0.1",
        port: Number(process.env.MUSE_FIXTURE_TOOL_GATE_PORT),
      });
      gate.once("data", () => {
        gate.end();
        finish();
      });
      return;
    }
    finish();
    return;
  }
  answerText();
}
function answerText() {
  const text =
    active.prompt === "credential"
      ? `credential:${process.env.META_API_KEY ?? "cli-login"}`
      : active.prompt === "effort"
        ? `effort:${active.reasoningEffort}`
        : `${active.resumed ? "resumed" : "started"}: hello`;
  const messageId = item("agentMessage", "inProgress", { text: "" });
  event("item/delta", { itemId: messageId, delta: text.slice(0, 8) });
  event("item/delta", { itemId: messageId, delta: text.slice(8) });
  item("agentMessage", "completed", { text });
  if (active.prompt !== "settle") {
    complete("completed");
  }
}
createInterface({ input: process.stdin }).on("line", (line) => {
  log(line);
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "initialize") {
    const result = {
      serverInfo: { name: "fake_muse", version: "1" },
      schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT, version: 1 },
      grantedCapabilities: [],
      experimentalApi: false,
      platformOs: "linux",
    };
    if (process.env.MUSE_FIXTURE_INITIALIZE_GATE) {
      const gate = createConnection(process.env.MUSE_FIXTURE_INITIALIZE_GATE);
      gate.on("connect", () => gate.write(String(process.pid)));
      gate.once("data", () => reply(id, result));
      return;
    }
    reply(id, result);
  } else if (method === "model/list") {
    if (process.env.MUSE_FIXTURE_CATALOG_PATH) {
      reply(id, JSON.parse(readFileSync(process.env.MUSE_FIXTURE_CATALOG_PATH, "utf8")));
      return;
    }
    reply(id, {
      providerId: "meta",
      profileId: "fixture",
      source: process.env.MUSE_FIXTURE_CATALOG_SOURCE ?? "providerCatalog",
      models:
        process.env.META_API_KEY === "rejected-test-key"
          ? []
          : [{ providerId: "meta", modelId: "muse-spark-1.3" }],
    });
  } else if (method === "session/start" || method === "session/resume") {
    const resumed = method === "session/resume";
    // Muse 1.3 uses `internal` for retained sessions it can no longer compose.
    const refusal = new Map([
      ["missing-session", [-32020, "session not found", "sessionNotFound"]],
      ["refused-session", [-32603, "retained session refused (class c)", "internal"]],
      ["busy-session", [-32021, "session in use", "sessionInUse"]],
    ]).get(params.sessionId);
    if (resumed && refusal) {
      reject(id, ...refusal);
      return;
    }
    const sessionId = resumed
      ? params.sessionId
      : process.env.MUSE_REQUEST_LOG
        ? randomUUID()
        : `session-${++sessionCount}`;
    sessions.set(sessionId, resumed);
    if (sessionId === "resumed-native-approval" || pendingNativeApproval) {
      outboundBatch = [];
    }
    reply(id, {
      session: { sessionId },
      ...(resumed ? { history: { mode: "none" } } : {}),
      viewCursor: String(cursor),
    });
    if (resumed && ["resumed-native-work", "resumed-native-approval"].includes(sessionId)) {
      active = { sessionId, turnId: "native-background-turn", prompt: "wait", resumed: true };
      if (sessionId === "resumed-native-approval" || pendingNativeApproval) {
        event("turn/started", { commandId: active.turnId, sourceRange });
        item("toolCall", "inProgress", {
          tool: "bash",
          callId: "native-tool",
          args: '{"command":"work"}',
        });
        nativeApproval();
        process.stdout.write(outboundBatch.join(""));
        outboundBatch = undefined;
      }
    }
  } else if (method === "turn/start") {
    if (
      ["resumed-native-work", "resumed-native-approval"].includes(params.sessionId) &&
      active?.turnId === "native-background-turn"
    ) {
      // Resume may restore native background work before the next user submit.
      // Keep its actual turn, tool, and child identities when input steers it.
      event("turn/started", { commandId: active.turnId, sourceRange });
      item("toolCall", "inProgress", {
        tool: "bash",
        callId: "native-tool",
        args: '{"command":"work"}',
      });
      item("subagent", "inProgress", {
        subagentId: "native-child",
        fallbackText: "Existing child",
      });
      if (params.ifBusy !== "steer") {
        accept(id, params, {
          disposition: "queued",
          startedNewTurn: false,
          turnId: params.commandId,
        });
        return;
      }
      accept(id, params, { disposition: "steered", startedNewTurn: false, turnId: active.turnId });
      if (pendingNativeApproval) {
        return;
      }
      if (params.input[0].text.trim() === "approval-native-work") {
        nativeApproval();
        return;
      }
      if (params.input[0].text.trim() === "hold-after-answer") {
        item("agentMessage", "completed", { itemId: "earlier-answer", text: "Earlier answer" });
        return;
      }
      if (params.input[0].text.trim() === "fresh-after-answer") {
        setImmediate(() => {
          item("agentMessage", "completed", { itemId: "current-answer", text: "Current answer" });
          complete("completed");
        });
        return;
      }
      if (params.input[0].text.trim() === "hold-then-approval") {
        item("agentMessage", "completed", {
          itemId: "answer-before-detach",
          text: "Answer before detach",
        });
        setTimeout(() => {
          nativeApproval();
          log({ event: "late-approval-requested" });
        }, 80);
        return;
      }
      if (params.input[0].text.trim() === "hold-native-work") {
        return;
      }
      setImmediate(() => {
        item("toolCall", "completed", {
          tool: "bash",
          callId: "native-tool",
          args: '{"command":"work"}',
          visibleOutput: "Existing work finished",
        });
        item("subagent", "completed", {
          subagentId: "native-child",
          fallbackText: "Existing child finished",
        });
        answer();
      });
      return;
    }
    active = {
      sessionId: params.sessionId,
      turnId: params.commandId,
      // Gateway turns wrap the user text in OpenClaw context, so Docker prompts
      // carry an explicit `fixture:<keyword>` marker; direct tests send the bare keyword.
      prompt:
        /\bfixture:([a-z]+)\b/u.exec(params.input[0].text)?.[1] ?? params.input[0].text.trim(),
      resumed: sessions.get(params.sessionId),
      reasoningEffort: params.reasoningEffort,
    };
    accept(id, params, {
      disposition: "started",
      startedNewTurn: true,
      turnId: active.turnId,
    });
    setImmediate(() => {
      event("turn/started", { commandId: params.commandId, sourceRange });
      if (active.prompt === "crash") {
        process.stderr.write("fixture: provider process crashed\n");
        process.exit(7);
      } else if (active.prompt === "fail") {
        fail("providerError", "fixture provider rejected authentication");
      } else if (active.prompt === "loggedout") {
        // Muse 1.3 reports a missing credential this way.
        fail("authRequired", "not logged in: run /login to add an API key");
      } else if (
        active.prompt === "approval" ||
        active.prompt === "approval-settle" ||
        active.prompt === "approval-deny-only"
      ) {
        event("approval/requested", {
          // Real Muse mints one approval id per request; the SDK ignores repeats.
          approvalId: `approval-${active.turnId}`,
          currentRequirementId: { approvalId: `approval-${active.turnId}`, sourceIndex: 0 },
          availableChoices: [
            ...(active.prompt === "approval-deny-only"
              ? []
              : [
                  {
                    choiceId: "server-allow-id",
                    decision: "approved",
                    scope: "once",
                    label: "Allow",
                  },
                ]),
            {
              choiceId: active.prompt === "approval-deny-only" ? "server-only" : "server-deny-id",
              decision: "denied",
              scope: "once",
              label: "Deny",
            },
          ],
          itemId: `tool-${active.turnId}`,
          toolCallId: `call-${active.turnId}`,
          toolName: "shell",
          rawArgs: '{"command":"pwd"}',
          subject: { kind: "command", command: "pwd" },
          judgeEscalated: false,
          protectedWrite: false,
          taskId: "task-1",
          sourceRange,
        });
      } else if (active.prompt !== "wait") {
        answer();
      }
    });
  } else if (method === "approval/decide") {
    accept(id, params, { approvalId: params.approvalId });
    if (params.approvalId === "native-approval") {
      pendingNativeApproval = false;
      if (params.choiceId === "native-deny") {
        item("toolCall", "failed", {
          tool: "bash",
          callId: "native-tool",
          failureReason: "Approval denied",
        });
        fail("approvalDenied", "Approval denied");
      } else {
        if (process.env.MUSE_FIXTURE_EFFECT_PATH) {
          writeFileSync(process.env.MUSE_FIXTURE_EFFECT_PATH, "approved native effect");
        }
        setImmediate(answer);
      }
      return;
    }
    if (params.choiceId !== "server-allow-id") {
      fail("approvalDenied", "denied");
    } else {
      setImmediate(answer);
    }
  } else if (method === "turn/interrupt") {
    accept(id, params);
    if (active?.sessionId === "resumed-native-work" && params.turnId !== active.turnId) {
      // Interrupting a queued submit does not stop the existing native work.
      send({
        method: "turn/completed",
        params: {
          sessionId: active.sessionId,
          turnId: params.turnId,
          terminal: "cancelled",
          sourceRange,
          viewCursor: String(++cursor),
        },
      });
      return;
    }
    if (active.prompt === "settle" || active.prompt === "approval-settle") {
      // Deliberately separate admission from native settlement.
      setTimeout(() => complete("cancelled"), 80);
    } else {
      complete("cancelled");
    }
  } else if (method !== "initialized") {
    send({ id, error: { code: -32601, message: `Unsupported fixture method ${method}` } });
  }
});
