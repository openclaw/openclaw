#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const port = Number(process.env.MOCK_PORT || 19_882);
const requestLog = process.env.MOCK_REQUEST_LOG;
const scenario = process.env.E2E_TRIAGE_SCENARIO;

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function startEvents(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
}

function completionChunk(id, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function writeEvents(response, events) {
  startEvents(response);
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function writeInterleavedMonologue(response) {
  const id = "chatcmpl_interleaved_monologue";
  writeEvents(response, [
    completionChunk(id, {
      role: "assistant",
      reasoning_details: [
        { type: "response.output_text", text: "PRIVATE_MONOLOGUE" },
        { type: "reasoning.text", text: "HIDDEN_REASONING" },
        { type: "response.text", text: "PUBLIC_FINAL" },
      ],
    }),
    completionChunk(id, {}, "stop"),
  ]);
}

function writeIncompleteToolUse(response) {
  const id = "chatcmpl_incomplete_tool_use";
  writeEvents(response, [
    completionChunk(id, { role: "assistant" }),
    completionChunk(id, {}, "tool_calls"),
  ]);
}

async function writePreviewToolBoundary(response, body) {
  const toolResults = (body.messages ?? []).filter((message) => message.role === "tool").length;
  if (scenario === "preview-tool-error" && toolResults > 0) {
    writeJson(response, 400, {
      error: { type: "invalid_request_error", message: "PREVIEW_PROVIDER_FAILURE_25592" },
    });
    return;
  }
  if (body.stream !== true || !body.tools?.some((tool) => tool.function?.name === "exec")) {
    writeJson(response, 400, { error: { message: "Preview fixture requires streaming and exec" } });
    return;
  }
  startEvents(response);
  const writeChunk = (delta, finishReason = null) =>
    response.write(
      `data: ${JSON.stringify(completionChunk(`chatcmpl_preview_${toolResults}`, delta, finishReason))}\n\n`,
    );
  writeChunk({ role: "assistant" });
  if (toolResults === 0) {
    writeChunk({ content: "PREVIEW_PREAMBLE_25592: I will inspect the workspace." });
    // Let the unphased preview become visible before the provider reveals a tool call.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  if (toolResults < 2) {
    writeChunk({
      tool_calls: [
        {
          index: 0,
          id: `call_preview_${toolResults}`,
          type: "function",
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: `printf preview-step-${toolResults}` }),
          },
        },
      ],
    });
    writeChunk({}, "tool_calls");
  } else {
    writeChunk({ content: "PREVIEW_FINAL_25592" });
    writeChunk({}, "stop");
  }
  response.end("data: [DONE]\n\n");
}

function messageStartEvents(item, deltas = [item.content[0].text]) {
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    ...deltas.map((delta) => ({
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta,
    })),
  ];
}

function messageDoneEvents(item) {
  return [
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: item.content[0].text,
    },
    { type: "response.output_item.done", output_index: 0, item },
  ];
}

function functionCallEvents(item, outputIndex = 0) {
  return [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...item, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: outputIndex,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: outputIndex, item },
  ];
}

function completedEvent(id, output) {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output,
      usage: { input_tokens: 32, output_tokens: 8, total_tokens: 40 },
    },
  };
}

async function writeStreamingThrottle(response) {
  const item = {
    type: "message",
    id: "msg_streaming_throttle_107179",
    role: "assistant",
    phase: "final_answer",
    status: "completed",
    content: [{ type: "output_text", text: "STREAM_FINAL_107179", annotations: [] }],
  };
  startEvents(response);
  for (const event of messageStartEvents(item, ["QA streaming ", "preview in ", "progress"])) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  for (const event of [
    ...messageDoneEvents(item),
    completedEvent("resp_streaming_throttle_107179", [item]),
  ]) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function responseEvents(text) {
  const item = {
    type: "message",
    id: "msg_telegram_triage_fixture",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    ...messageStartEvents(item),
    ...messageDoneEvents(item),
    completedEvent("resp_telegram_triage_fixture", [item]),
  ];
}

function functionCallResponse(name, argumentsText, suffix) {
  const item = {
    type: "function_call",
    id: `fc_${name}_${suffix}`,
    call_id: `call_${name}_${suffix}`,
    name,
    arguments: argumentsText,
  };
  return [...functionCallEvents(item), completedEvent(`resp_${name}_${suffix}`, [item])];
}

function toolCallEvents(sequence) {
  const args = JSON.stringify({ args: { id: "session_status", args: {} } });
  const suffix = createHash("sha256").update(`${sequence}:${args}`).digest("hex").slice(0, 10);
  return functionCallResponse("tool_call", args, suffix);
}

function namedToolCallEvents(name, args, sequence) {
  const argumentsText = JSON.stringify(args);
  const suffix = createHash("sha256")
    .update(`${name}:${sequence}:${argumentsText}`)
    .digest("hex")
    .slice(0, 10);
  return functionCallResponse(name, argumentsText, suffix);
}

function hasTool(body, name) {
  return Array.isArray(body.tools) && body.tools.some((tool) => tool?.name === name);
}

function draftThenExecEvents() {
  const message = {
    type: "message",
    id: "msg_good_draft_115041",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "GOOD_DRAFT_115041", annotations: [] }],
  };
  const call = {
    type: "function_call",
    id: "fc_exec_115041",
    call_id: "call_exec_115041",
    name: "exec",
    arguments: JSON.stringify({ command: "printf tool-ok" }),
  };
  return [
    ...messageStartEvents(message),
    ...messageDoneEvents(message),
    ...functionCallEvents(call, 1),
    completedEvent("resp_good_draft_115041", [message, call]),
  ];
}

function countFunctionOutputs(value) {
  if (Array.isArray(value))
    return value.reduce((total, item) => total + countFunctionOutputs(item), 0);
  if (!value || typeof value !== "object") return 0;
  return (
    (value.type === "function_call_output" ? 1 : 0) +
    Object.values(value).reduce((total, item) => total + countFunctionOutputs(item), 0)
  );
}

const server = http.createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      writeJson(response, 200, {
        object: "list",
        data: ["gpt-5.5", "primary", "fallback"].map((id) => ({
          id,
          object: "model",
          owned_by: "openclaw-e2e",
        })),
      });
      return;
    }
    let bodyText = "";
    for await (const chunk of request) bodyText += chunk;
    if (requestLog) fs.appendFileSync(requestLog, `${bodyText}\n`);
    const body = bodyText ? JSON.parse(bodyText) : {};
    if (
      (scenario === "preview-tool-boundaries" || scenario === "preview-tool-error") &&
      request.method === "POST" &&
      url.pathname === "/v1/chat/completions"
    ) {
      await writePreviewToolBoundary(response, body);
      return;
    }
    if (
      scenario === "interleaved-monologue" &&
      request.method === "POST" &&
      url.pathname === "/v1/chat/completions"
    ) {
      writeInterleavedMonologue(response);
      return;
    }
    if (
      scenario === "incomplete-tool-use" &&
      request.method === "POST" &&
      url.pathname === "/v1/chat/completions"
    ) {
      writeIncompleteToolUse(response);
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      writeJson(response, 404, { error: { message: "unhandled fixture route" } });
      return;
    }
    if (scenario === "streaming-throttle") {
      await writeStreamingThrottle(response);
      return;
    }
    if (scenario === "tool-search-double-wrap") {
      const outputCount = countFunctionOutputs(body.input);
      writeEvents(
        response,
        outputCount < 2 ? toolCallEvents(outputCount) : responseEvents("NO_REPLY"),
      );
      return;
    }
    if (scenario === "model-fallback-room") {
      if (body.model === "primary") {
        response.setHeader("retry-after-ms", "0");
        writeJson(response, 503, {
          error: {
            type: "server_error",
            code: "server_error",
            message: "PRIMARY_ROUTE_UNAVAILABLE",
          },
        });
        return;
      }
      writeEvents(response, responseEvents("FALLBACK_ROUTE_OK"));
      return;
    }
    if (scenario === "yield-message-drop") {
      const inputText = JSON.stringify(body.input ?? []);
      if (inputText.includes("CHILD_DELAY_107788") && !hasTool(body, "sessions_yield")) {
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        writeEvents(response, responseEvents("CHILD_COMPLETE_107788"));
        return;
      }
      const outputCount = countFunctionOutputs(body.input);
      if (outputCount === 0) {
        writeEvents(
          response,
          namedToolCallEvents(
            "sessions_spawn",
            {
              task: "Wait, then reply exactly CHILD_COMPLETE_107788. CHILD_DELAY_107788",
              taskName: "telegram-yield-repro",
              cleanup: "keep",
              context: "isolated",
            },
            0,
          ),
        );
        return;
      }
      writeEvents(
        response,
        namedToolCallEvents("sessions_yield", { message: "RESEARCH_STARTED_107788" }, outputCount),
      );
      return;
    }
    if (scenario === "edit-failure-recovery") {
      const outputCount = countFunctionOutputs(body.input);
      if (outputCount === 0) {
        writeEvents(
          response,
          namedToolCallEvents("write", { path: "repro-46548.txt", content: "alpha\n" }, 0),
        );
        return;
      }
      if (outputCount === 1) {
        writeEvents(
          response,
          namedToolCallEvents(
            "edit",
            { path: "repro-46548.txt", edits: [{ oldText: "beta", newText: "omega" }] },
            1,
          ),
        );
        return;
      }
      if (outputCount === 2) {
        writeEvents(
          response,
          namedToolCallEvents(
            "edit",
            { path: "repro-46548.txt", edits: [{ oldText: "alpha", newText: "omega" }] },
            2,
          ),
        );
        return;
      }
      writeEvents(response, responseEvents("EDIT_RECOVERY_DONE_46548"));
      return;
    }
    if (scenario === "terminal-no-reply-drops-draft") {
      const outputCount = countFunctionOutputs(body.input);
      writeEvents(response, outputCount === 0 ? draftThenExecEvents() : responseEvents("NO_REPLY"));
      return;
    }
    if (scenario === "terminal-failure-after-success") {
      const outputCount = countFunctionOutputs(body.input);
      if (outputCount === 0) {
        writeEvents(
          response,
          namedToolCallEvents("write", { path: "repro-118489.txt", content: "alpha\n" }, 0),
        );
        return;
      }
      if (outputCount === 1) {
        writeEvents(
          response,
          namedToolCallEvents(
            "edit",
            { path: "repro-118489.txt", edits: [{ oldText: "missing", newText: "omega" }] },
            1,
          ),
        );
        return;
      }
      writeEvents(response, responseEvents("NO_REPLY"));
      return;
    }
    if (scenario === "cron-self-narration") {
      const prompt = JSON.stringify(body.input ?? []);
      const hasRecipientOnlyGuidance = prompt.includes("exact user-facing message to send");
      writeEvents(
        response,
        responseEvents(
          hasRecipientOnlyGuidance
            ? "SCHEDULE_CONFIRMED_90836"
            : "I sent the user: SCHEDULE_CONFIRMED_90836",
        ),
      );
      return;
    }
    writeJson(response, 500, { error: { message: `unknown E2E_TRIAGE_SCENARIO: ${scenario}` } });
  })().catch((error) => {
    writeJson(response, 500, {
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-openai listening on ${server.address().port}`);
});
