#!/usr/bin/env node
import { createInterface } from "node:readline";

const scenario = readArg("--scenario") || "user-input-other";
if (scenario !== "user-input-other") {
  throw new Error(`Unsupported Codex fixture scenario: ${scenario}`);
}

let nextRequestId = 1;
let activeThreadId = "qa-thread-1";
let activeTurnId = "qa-turn-1";

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  const prefixed = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : undefined;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  write({ id, result: value });
}

function error(id, message) {
  write({ id, error: { code: -32601, message } });
}

function request(method, params) {
  const id = `qa-request-${nextRequestId++}`;
  write({ id, method, params });
  return id;
}

function readAnswerText(value) {
  const answers = value?.answers;
  const custom = answers?.custom?.answers;
  if (Array.isArray(custom) && typeof custom[0] === "string") {
    return custom[0];
  }
  return "";
}

function completeTurn(answerText) {
  const text = `OPENCLAW_QA_CODEX_USER_INPUT_OK ${answerText}`;
  write({
    method: "item/completed",
    params: {
      threadId: activeThreadId,
      turnId: activeTurnId,
      item: {
        id: "qa-answer-1",
        type: "agentMessage",
        text,
      },
    },
  });
  write({
    method: "turn/completed",
    params: {
      threadId: activeThreadId,
      turnId: activeTurnId,
      turn: {
        id: activeTurnId,
        status: "completed",
      },
    },
  });
}

function handleRequest(message) {
  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: "0.1.0",
      serverInfo: {
        name: "openclaw-qa-codex-fixture",
        version: "0.132.0",
      },
      userAgent: "codex-cli/0.132.0",
    });
    return;
  }
  if (message.method === "thread/start") {
    activeThreadId = "qa-thread-1";
    result(message.id, {
      model: "gpt-5.5-codex-fixture",
      modelProvider: "codex-fixture",
      thread: {
        id: activeThreadId,
        cwd: message.params?.cwd ?? process.cwd(),
        status: { type: "idle" },
      },
    });
    return;
  }
  if (message.method === "thread/resume") {
    activeThreadId = message.params?.threadId || activeThreadId;
    result(message.id, {
      model: "gpt-5.5-codex-fixture",
      modelProvider: "codex-fixture",
      thread: {
        id: activeThreadId,
        cwd: message.params?.cwd ?? process.cwd(),
        status: { type: "idle" },
      },
    });
    return;
  }
  if (message.method === "turn/start") {
    activeThreadId = message.params?.threadId || activeThreadId;
    activeTurnId = "qa-turn-1";
    result(message.id, {
      turn: {
        id: activeTurnId,
        threadId: activeThreadId,
        status: "active",
        items: [],
      },
    });
    request("item/tool/requestUserInput", {
      threadId: activeThreadId,
      turnId: activeTurnId,
      itemId: "qa-user-input-1",
      questions: [
        {
          id: "custom",
          header: "QA Other Answer",
          question: "Type the QA Other answer.",
          isOther: true,
          isSecret: false,
          options: [{ label: "Use default", description: "Not used by this QA scenario." }],
        },
      ],
    });
    return;
  }
  if (message.method === "turn/interrupt") {
    result(message.id, {});
    return;
  }
  error(message.id, `Unsupported method: ${message.method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  if (message.method) {
    handleRequest(message);
    return;
  }
  if (message.id && message.result) {
    completeTurn(readAnswerText(message.result));
  }
});
