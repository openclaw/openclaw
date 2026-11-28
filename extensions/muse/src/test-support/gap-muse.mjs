#!/usr/bin/env node
// Synthetic MSP peer: no network/credentials/native tools; one owned marker append models a native side effect.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";
const recordProvenance = (event, carrier) => {
  if (event.params?.sourceRange) {
    appendFileSync(
      receiptPath,
      JSON.stringify({
        kind: "source-provenance",
        carrier,
        event: event.method,
        viewCursor: event.params.viewCursor,
        sourceRange: event.params.sourceRange,
      }) + "\n",
    );
  }
};
const send = (value) => {
  if (value.method) {
    recordProvenance(value, "live");
  }
  for (const event of value.result?.events ?? []) {
    recordProvenance(event, "page");
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
};
const reply = (id, result) => send({ id, result });
const refuse = (id) =>
  send({
    id,
    error: { code: -32603, message: "synthetic page read failed", data: { kind: "internal" } },
  });
const receiptPath = process.env.MUSE_GAP_RECEIPT;
if (!receiptPath) {
  throw new Error("Run through the test, which owns the receipt and effect paths");
}
let active;
// SDK1.4.14 SourceRange: distinct deterministic records, stable overlap provenance.
function sourceRangeFor(viewCursor) {
  const positions = {
    "before-hole": ["synthetic-turn-start-record", 1],
    "missing-tool": ["synthetic-tool-record", 2],
    "after-hole": ["synthetic-answer-record", 3],
    terminal: ["synthetic-terminal-record", 4],
    "cancel-terminal": ["synthetic-cancel-record", 5],
  };
  const [id, sequence] = positions[viewCursor];
  return {
    first: { id, sequence },
    last: { id, sequence },
    stream: { id: active.sessionId, kind: "session" },
  };
}
function frame(method, viewCursor, extra) {
  return {
    method,
    params: {
      sessionId: active.sessionId,
      turnId: active.turnId,
      viewCursor,
      sourceRange: sourceRangeFor(viewCursor),
      ...extra,
    },
  };
}
function answerFrame() {
  return frame("item/completed", "after-hole", {
    item: {
      itemId: "answer",
      turnId: active.turnId,
      kind: "agentMessage",
      status: "completed",
      revision: 1,
      text: "The synthetic task finished.",
    },
  });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  // Only intentionally bounded protocol facts; never log environment or prompts.
  appendFileSync(
    receiptPath,
    JSON.stringify({ method, ...(method === "view/page" ? { params } : {}) }) + "\n",
  );
  if (method === "initialize") {
    reply(id, {
      serverInfo: { name: "synthetic-gap-peer", version: "1" },
      schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT, version: 1 },
      grantedCapabilities: [],
      experimentalApi: false,
      platformOs: "linux",
    });
  } else if (method === "session/start") {
    reply(id, { session: { sessionId: randomUUID() }, viewCursor: "origin" });
  } else if (method === "model/list") {
    reply(id, {
      providerId: "meta",
      profileId: "synthetic",
      source: "providerCatalog",
      models: [{ providerId: "meta", modelId: "muse-spark-1.3" }],
    });
  } else if (method === "turn/start") {
    const text = params.input
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    active = {
      noTool: text.includes("gap-case:no-tool"),
      sessionId: params.sessionId,
      turnId: params.commandId,
      failed: /gap-case:(page-failed|failed|cancelled)/u.test(text),
      terminal: text.includes("gap-case:failed")
        ? "failed"
        : text.includes("gap-case:cancelled")
          ? "cancelled"
          : "completed",
    };
    reply(id, {
      commandId: params.commandId,
      status: "accepted",
      disposition: "started",
      startedNewTurn: true,
      turnId: active.turnId,
    });
    setImmediate(() => {
      send(frame("turn/started", "before-hole", { commandId: active.turnId }));
      if (active.noTool) {
        send(answerFrame());
        send(frame("turn/completed", "terminal", { terminal: "completed" }));
        return;
      }
      // One real write precedes the omitted item. The diagnostic owns this path.
      appendFileSync(
        receiptPath + ".effect",
        JSON.stringify({ operation: "append", value: "synthetic-write", turnId: active.turnId }) +
          "\n",
      );
      // The omitted tool item is durable and recoverable in the successful control.
      send({
        method: "view/gap",
        params: { sessionId: active.sessionId, after: "before-hole", next: "after-hole" },
      });
      send(answerFrame());
    });
  } else if (method === "view/page") {
    if (active.failed) {
      refuse(id);
    } else {
      reply(id, {
        events: [
          frame("item/completed", "missing-tool", {
            item: {
              itemId: "missing-tool",
              turnId: active.turnId,
              kind: "toolCall",
              status: "completed",
              revision: 1,
              tool: "write_file",
              callId: "synthetic-write",
              args: '{"path":"owned-marker","content":"synthetic-write"}',
              visibleOutput: "synthetic write completed",
            },
          }),
          answerFrame(),
        ],
        nextCursor: null,
      });
    }
    send(
      frame("turn/completed", "terminal", {
        terminal: active.terminal,
        ...(active.terminal === "failed"
          ? { error: { kind: "providerError", message: "synthetic turn failed" } }
          : {}),
      }),
    );
  } else if (method === "turn/interrupt") {
    reply(id, { commandId: params.commandId, status: "accepted" });
    send(frame("turn/completed", "cancel-terminal", { terminal: "cancelled" }));
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: "unsupported synthetic method" } });
  }
});
