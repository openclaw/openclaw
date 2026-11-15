import { createHash } from "node:crypto";
// Only the model is synthetic. Spawn, yield, completion, policy, and delivery are real.
import fs from "node:fs";
import http from "node:http";
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const runToken = process.env.E2E_REPLY_POLICY_RUN;
const markers = (cell) => ({
  request: "REPLY_POLICY_REQUEST_" + cell + "_" + runToken,
  task: "REPLY_POLICY_CHILD_TASK_" + cell + "_" + runToken,
  child: "REPLY_POLICY_PRIVATE_CHILD_" + cell + "_" + runToken,
  final: "REPLY_POLICY_FINAL_" + cell + "_" + runToken,
});
const cell = process.env.E2E_REPLY_POLICY_CELL;
const marker = markers(cell);
const usage = {
  input_tokens: 64,
  output_tokens: 16,
  total_tokens: 80,
  input_tokens_details: { cached_tokens: 0 },
};
let spawnReceipt;
function log(facts) {
  fs.appendFileSync(
    process.env.MOCK_REQUEST_LOG,
    JSON.stringify({ at: Date.now(), ...facts }) + "\n",
  );
}
// Provider adapters may wrap a JSON tool result in content blocks. Parse, never infer
// acceptance from words in a prompt, description, or error message.
function result(value) {
  if (typeof value === "string") {
    try {
      return result(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (value.status || value.ok !== undefined) {
    return value;
  }
  if (value.details) {
    const found = result(value.details);
    if (found) {
      return found;
    }
  }
  for (const part of Array.isArray(value) ? value : (value.content ?? [])) {
    const found = result(part.text ?? part);
    if (found) {
      return found;
    }
  }
}
function textEvents(text) {
  const item = {
    type: "message",
    id: "msg_mock",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [], status: "in_progress" },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: { id: "resp_mock_text", status: "completed", output: [item], usage },
    },
  ];
}
function toolEvents(name, args) {
  const serialized = JSON.stringify(args),
    id = hash(name + serialized).slice(0, 10);
  const item = {
    type: "function_call",
    id: "fc_" + id,
    call_id: "call_" + id,
    name,
    arguments: serialized,
  };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: serialized },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: { id: "resp_" + id, status: "completed", output: [item], usage },
    },
  ];
}
function decide(body) {
  const input = Array.isArray(body.input) ? body.input : [];
  const raw = JSON.stringify(input);
  const tools = new Map((body.tools ?? []).map((tool) => [tool.name, tool]));
  if (!tools.size) {
    return { kind: "side", text: "ok" };
  }
  const calls = input.filter((item) => item.type === "function_call");
  const receipts = calls.map((call) => ({
    call,
    output: result(
      input.find((item) => item.type === "function_call_output" && item.call_id === call.call_id)
        ?.output,
    ),
  }));
  const spawned = receipts.find(
    ({ call, output }) => call.name === "sessions_spawn" && output?.status === "accepted",
  );
  const yielded = receipts.find(
    ({ call, output }) => call.name === "sessions_yield" && output?.status === "yielded",
  );
  const sent = receipts.find(
    ({ call, output }) =>
      call.name === "message" && (output?.ok === true || output?.status === "sent"),
  );
  if (spawned) {
    spawnReceipt = spawned.output;
    if (!spawnReceipt.runId || !spawnReceipt.childSessionKey) {
      throw new Error("SPAWN_IDENTITY_MISSING");
    }
  }
  const facts = {
    messageToolAvailable: tools.has("message"),
    toolSchemaHashes: Object.fromEntries(
      ["sessions_spawn", "sessions_yield", "message"]
        .filter((name) => tools.has(name))
        .map((name) => [name, hash(JSON.stringify(tools.get(name).parameters))]),
    ),
    receipts: receipts.map(({ call, output }) => ({
      tool: call.name,
      callId: hash(call.call_id),
      status: output?.status,
      ok: output?.ok,
      context: output?.context,
      mode: output?.mode,
      childRun: output?.runId ? hash(output.runId) : undefined,
      childSession: output?.childSessionKey ? hash(output.childSessionKey) : undefined,
    })),
  };
  const tool = (name, args, kind) => {
    const schema = tools.get(name)?.parameters;
    if (!schema || Object.keys(args).some((key) => !schema.properties?.[key])) {
      throw new Error("TOOL_SCHEMA_MISMATCH_" + name);
    }
    return { ...facts, kind, tool: name, args };
  };
  if (!raw.includes(marker.request) && raw.includes(marker.task)) {
    return {
      ...facts,
      kind: "child",
      text: marker.child,
      childSessionMatchesSpawn: Boolean(spawnReceipt) && raw.includes(spawnReceipt.childSessionKey),
    };
  }
  if (!raw.includes(marker.request)) {
    throw new Error("UNKNOWN_MODEL_TURN");
  }
  if (!spawned) {
    if (calls.some((call) => call.name === "sessions_spawn")) {
      throw new Error("SPAWN_NOT_ACCEPTED");
    }
    return tool(
      "sessions_spawn",
      {
        task: marker.task + ". Return the private result.",
        taskName: "reply-policy-child",
        mode: "run",
        context: "isolated",
        completionTarget: "parent",
      },
      "spawn",
    );
  }
  if (!yielded) {
    if (calls.some((call) => call.name === "sessions_yield")) {
      throw new Error("YIELD_NOT_ACCEPTED");
    }
    return tool("sessions_yield", {}, "yield");
  }
  if (!raw.includes(marker.child)) {
    return { ...facts, kind: "after-yield", text: "NO_REPLY" };
  }
  const completed = {
    ...facts,
    receivedChildResult: true,
    childSessionMatchesSpawn: raw.includes(spawnReceipt.childSessionKey),
    childRun: hash(spawnReceipt.runId),
  };
  if (cell === "message-tool-send" && !sent) {
    if (calls.some((call) => call.name === "message")) {
      throw new Error("MESSAGE_NOT_ACCEPTED");
    }
    const target = JSON.parse(
      fs.readFileSync(process.env.E2E_REPLY_POLICY_TARGET_FILE, "utf8"),
    ).target;
    return {
      ...completed,
      ...tool(
        "message",
        { action: "send", channel: "telegram", target, message: marker.final, final: false },
        "settle-message",
      ),
    };
  }
  return {
    ...completed,
    kind: "settle-final",
    text: cell === "message-tool-send" ? "NO_REPLY" : marker.final,
  };
}
http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({ object: "list", data: [{ id: "gpt-5.5", object: "model" }] }),
      );
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.url !== "/v1/responses") {
        res.writeHead(404);
        return res.end();
      }
      try {
        const decision = decide(JSON.parse(raw));
        const { args, ...safe } = decision;
        log({
          ...safe,
          emittedText: decision.text,
          text: undefined,
          emittedTool: decision.tool,
          messageFinal: decision.tool === "message" ? args.final : undefined,
        });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        const events = decision.tool ? toolEvents(decision.tool, args) : textEvents(decision.text);
        for (const event of events) {
          res.write("data: " + JSON.stringify(event) + "\n\n");
        }
        res.end("data: [DONE]\n\n");
      } catch (error) {
        log({
          kind: "fixture-error",
          code: /^[A-Z_]+$/.test(error.message) ? error.message : "MOCK_INPUT_ERROR",
        });
        res.writeHead(400);
        res.end();
      }
    });
  })
  .listen(Number(process.env.MOCK_PORT), "127.0.0.1", () => console.log("mock-openai listening"));
