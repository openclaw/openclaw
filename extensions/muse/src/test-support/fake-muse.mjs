#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
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
const sessions = new Map();
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
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
function answer() {
  const itemId = item("reasoning", "inProgress", { text: "" });
  event("item/delta", { itemId, field: "summary.0", delta: "Considering" });
  item("reasoning", "completed", { text: "", summary: ["Considering"] });
  if (active.prompt === "tool" || active.prompt === "tool-failure") {
    item("toolCall", active.prompt === "tool-failure" ? "failed" : "completed", {
      tool: "read_file",
      callId: "call-1",
      args: '{"path":"a.txt"}',
      visibleOutput: "file content",
    });
  }
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
    reply(id, {
      session: { sessionId },
      ...(resumed ? { history: { mode: "none" } } : {}),
      viewCursor: String(cursor),
    });
  } else if (method === "turn/start") {
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
    if (params.choiceId !== "server-allow-id") {
      fail("approvalDenied", "denied");
    } else {
      setImmediate(answer);
    }
  } else if (method === "turn/interrupt") {
    accept(id, params);
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
