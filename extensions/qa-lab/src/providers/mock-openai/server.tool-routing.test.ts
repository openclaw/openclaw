import { expect, it } from "vitest";
import { readQaScenarioExecutionConfig } from "../../scenario-catalog.js";
import type { AnthropicMessage } from "./mock-openai-contracts.js";
import {
  QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
  createMockServerTestHarness,
  expectNonStreamingResponsesJson,
  expectOk,
  expectResponses,
  getJson,
  makeToolOutputWithCallId,
  makeUserInput,
  outputItems,
  outputText,
  outputToolArgsFromItem as callArgs,
  outputToolCall,
  postJson,
  postResponses,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
const catalogTools = ["tool_call", "tool_search", "tool_describe", "sessions_yield"].map(
  (name) => ({
    type: "function",
    name,
  }),
);
const shellExec = {
  type: "function",
  name: "exec",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};
const namespace = [{ type: "namespace", name: "openclaw", tools: catalogTools }];
function catalogOutput(name: string, result: Record<string, unknown>) {
  return JSON.stringify({ tool: { id: `openclaw:${name}`, name, source: "openclaw" }, result });
}
function catalogResult(name: string, details: Record<string, unknown>) {
  return catalogOutput(name, {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  });
}
async function startTurn(prompt: string, body: Record<string, unknown> = {}) {
  const server = await startMockServer();
  const input: unknown[] = [makeUserInput(prompt)];
  const request = () =>
    expectNonStreamingResponsesJson(server, { tools: catalogTools, ...body, input });
  const complete = (call: Record<string, unknown>, output: string) => {
    input.push(call, makeToolOutputWithCallId(String(call.call_id), output));
    return request();
  };
  return { server, input, request, complete };
}

it.each([
  {
    action: "react",
    prompt:
      "openclawqa React to this WhatsApp group message with thumbs up for QA action check WHATSAPP_QA_GROUP_AGENT_REACT_TEST. Do not send any visible text reply after the reaction.",
    args: { action: "react", emoji: "👍", final: true },
  },
  {
    action: "upload-file",
    prompt:
      "Use the WhatsApp message tool upload-file action to send a PNG with caption WHATSAPP_QA_AGENT_UPLOAD_TEST. Do not send any visible text reply after the upload.",
    args: {
      action: "upload-file",
      caption: "WHATSAPP_QA_AGENT_UPLOAD_TEST",
      contentType: "image/png",
    },
  },
])(
  "completes WhatsApp $action through the namespaced catalog with intentional silence",
  async ({ prompt, args }) => {
    const turn = await startTurn(prompt, {
      model: "gpt-5.6-luna",
      tools: [shellExec, ...namespace],
    });
    turn.input.unshift({
      role: "developer",
      content: "## Messaging\n### message tool\n- Proactive send/channel action: `message`.",
    });
    const payload = await turn.request();
    expect(outputItems(payload)).toHaveLength(1);
    const call = outputToolCall(payload, "tool_call");
    expect(call.namespace).toBe("openclaw");
    expect(callArgs(call)).toMatchObject({ id: "message", args });
    expect(await getJson(turn.server, "/debug/last-request")).toMatchObject({
      plannedToolName: "message",
      plannedWireToolName: "tool_call",
    });
    const completed = await turn.complete(call, catalogResult("message", { ok: true }));
    expect(outputItems(completed).some((item) => item.type === "function_call")).toBe(false);
    expect(outputText(completed)).toBe("NO_REPLY");
    const continuation = await expectNonStreamingResponsesJson(turn.server, {
      model: "gpt-5.6-luna",
      tools: [],
      input: [...turn.input, makeUserInput(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION)],
    });
    expect(outputItems(continuation).some((item) => item.type === "function_call")).toBe(false);
    expect(outputText(continuation)).toBe("NO_REPLY");
  },
);

it("plans runtime-fixture sessions_spawn happy and failure calls deterministically", async () => {
  const turn = await startTurn(
    "QA routing marker: tool search qa check target=sessions_spawn. Call sessions_spawn directly exactly once and summarize its acceptance.",
    { model: "gpt-5.6-luna", tools: [{ type: "function", name: "sessions_spawn" }] },
  );
  expect(callArgs(outputToolCall(await turn.request(), "sessions_spawn"))).toMatchObject({
    mode: "run",
    expectsCompletionMessage: false,
  });
  turn.input.splice(
    0,
    1,
    makeUserInput(
      'QA routing marker: tool search qa failure target=sessions_spawn. Call sessions_spawn directly exactly once with task="". Do not repair, omit, replace, or retry the empty task.',
    ),
  );
  expect(callArgs(outputToolCall(await turn.request(), "sessions_spawn"))).toEqual({ task: "" });
});

it("routes the directory fixture through ls with valid happy and missing-directory inputs", async () => {
  const config = readQaScenarioExecutionConfig("runtime-tool-fs-list") ?? {};
  const turn = await startTurn("", {
    tools: ["ls", "read"].map((name) => ({ type: "function", name })),
  });
  for (const [prompt, expectedPath] of [
    [config.happyPrompt ?? `tool search qa check target=${config.toolName}`, "."],
    [
      config.failurePrompt ?? `tool search qa failure target=${config.toolName}`,
      "runtime-tool-fixture-missing-directory",
    ],
  ]) {
    turn.input.splice(0, 1, makeUserInput(String(prompt)));
    expect(callArgs(outputToolCall(await turn.request(), "ls"))).toEqual({ path: expectedPath });
  }
});

it("does not mistake shell exec or discovery without invocation for spawn authority", async () => {
  const turn = await startTurn("Subagent terminal reply QA check: visible.", {
    model: "gpt-5.6-luna",
    tools: [...catalogTools.filter((tool) => tool.name !== "tool_call"), shellExec],
    instructions: "sessions_spawn and tool_call are mentioned but not declared.",
  });
  expect(outputItems(await turn.request()).some((item) => item.type === "function_call")).toBe(
    false,
  );
});

it.each([true, false])(
  "honors protocol failure %s over accepted catalog details",
  async (isError) => {
    const server = await startMockServer();
    const messages: AnthropicMessage[] = [
      {
        role: "user",
        content: "Delegate one bounded QA task to a subagent. Wait for the subagent to finish.",
      },
    ];
    const request = async () =>
      (
        await expectOk(
          postJson(server, "/v1/messages", {
            model: "qa-model",
            max_tokens: 128,
            stream: false,
            tools: ["tool_call", "sessions_yield"].map((name) => ({
              name,
              input_schema: { type: "object" },
            })),
            messages,
          }),
        )
      ).json();
    const call = (await request()).content[0];
    expect(call).toMatchObject({ type: "tool_use", name: "tool_call" });
    messages.push(
      { role: "assistant", content: [call] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: call.id,
            is_error: isError,
            content: catalogResult("sessions_spawn", {
              status: "accepted",
              runId: "child-run",
              childSessionKey: "agent:qa:subagent:protocol-receipt",
            }),
          },
        ],
      },
    );
    expect((await request()).content).toEqual([
      isError
        ? { type: "text", text: "Failed to delegate: spawn failed" }
        : expect.objectContaining({ type: "tool_use", name: "sessions_yield" }),
    ]);
  },
);

it("sends a private-source completion once through the catalog and never respawns", async () => {
  const turn = await startTurn("Subagent terminal reply QA check: silent.", {
    model: "gpt-5.6-luna",
    instructions:
      "## Messaging\n### message tool\nVisible source replies are not automatically delivered for this run. Use message(action=send) for user-visible source-channel output. When the message is the completed reply to the current source conversation, set final=true.",
  });
  turn.input.push(
    makeUserInput(
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n[Internal task completion event]\nTask: qa-terminal-silent\nResult: (no output)\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ),
  );
  const call = outputToolCall(await turn.request(), "tool_call");
  expect(callArgs(call)).toEqual({
    id: "message",
    args: { action: "send", message: "QA-SUBAGENT-TERMINAL-SILENT-REPRESENTED", final: true },
  });
  expect(outputText(await turn.complete(call, catalogResult("message", { ok: true })))).toBe("");
});

it("keeps the private second-child completion silent with catalog-only tools", async () => {
  const turn = await startTurn("Subagent terminal reply QA check: private.", {
    model: "gpt-5.6-luna",
  });
  turn.input.push(
    makeUserInput(
      "[Internal task completion event]\nTask: qa-terminal-private-first\nResult: QA-PARENT-PRIVATE-CHILD1-0123456789ABCDEF0123456789ABCDEF\nMEDIA:./qa-private-result.png",
    ),
  );
  const call = outputToolCall(await turn.request(), "tool_call");
  expect(callArgs(call)).toMatchObject({
    id: "sessions_spawn",
    args: { label: "qa-terminal-private-second", completionTarget: "parent" },
  });
  expect(
    outputText(await turn.complete(call, catalogResult("sessions_spawn", { status: "accepted" }))),
  ).toBe("NO_REPLY");
});

it("drives yielded-parent fallback through catalog spawn and namespaced yield", async () => {
  const tools = [
    ...catalogTools.filter((tool) => tool.name !== "sessions_yield"),
    {
      type: "namespace",
      name: "openclaw_direct",
      tools: [{ type: "function", name: "sessions_yield" }],
    },
  ];
  const turn = await startTurn(
    "Subagent direct fallback QA check: spawn one worker and yield until QA-SUBAGENT-DIRECT-FALLBACK-OK is delivered.",
    { tools },
  );
  const call = outputToolCall(await turn.request(), "tool_call");
  const args = callArgs(call);
  expect(args).toMatchObject({
    id: "sessions_spawn",
    args: { label: "qa-direct-fallback-worker", thread: false, mode: "run" },
  });
  expect(args.args).not.toHaveProperty("runTimeoutSeconds");
  expect(await getJson(turn.server, "/debug/last-request")).toMatchObject({
    plannedToolName: "sessions_spawn",
    plannedWireToolName: "tool_call",
    plannedToolArgs: args.args,
  });
  turn.input.push(
    call,
    makeToolOutputWithCallId(
      String(call.call_id),
      JSON.stringify({
        status: "accepted",
        childSessionKey: "agent:qa:subagent:child",
        runId: "run-child-1",
      }),
    ),
  );
  const body = await (
    await expectResponses(turn.server, { stream: true, tools, input: turn.input })
  ).text();
  expect(body).toContain('"name":"sessions_yield"');
  expect(body).toContain("QA-SUBAGENT-DIRECT-FALLBACK-OK");
  expect(body.match(/"namespace":"openclaw_direct"/g)).toHaveLength(3);
  expect(await getJson(turn.server, "/debug/last-request")).toMatchObject({
    plannedToolName: "sessions_yield",
  });
});

it("resolves the current Telegram session through developer additional tools", async () => {
  const sessionKey = "agent:qa:telegram:group:qa-command-room";
  const turn = await startTurn(
    "Telegram current session_status QA check. Call session_status with sessionKey set to current, then reply with the exact QA marker and resolved session key.",
    { tools: [] },
  );
  turn.input.unshift(
    {
      role: "system",
      content: [{ type: "input_text", text: "Use session_status to inspect the current session." }],
    },
    { type: "additional_tools", role: "developer", tools: namespace },
  );
  const call = outputToolCall(await turn.request(), "tool_call");
  expect(call.namespace).toBe("openclaw");
  expect(callArgs(call)).toEqual({ id: "session_status", args: { sessionKey: "current" } });
  expect(
    outputText(
      await turn.complete(call, catalogOutput("session_status", { details: { sessionKey } })),
    ),
  ).toBe(`QA-TELEGRAM-CURRENT-SESSION-OK ${sessionKey}`);
});

it("tracks a deferred command and its poll through namespaced dynamic tools", async () => {
  const turn = await startTurn(
    "Tool progress QA check: call the exec tool exactly once with this exact command before answering: `true`. After that command completes, reply exactly `PROGRESS_OK`.",
    { tools: [], dynamicTools: namespace },
  );
  const command = outputToolCall(await turn.request(), "tool_call");
  expect(command.namespace).toBe("openclaw");
  expect(callArgs(command)).toEqual({ id: "exec", args: { command: "true" } });
  const poll = outputToolCall(
    await turn.complete(
      command,
      catalogOutput("exec", {
        content: [
          {
            type: "text",
            text: "Command still running (session bounded-command, pid 3128). Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
          },
        ],
        details: { status: "running", sessionId: "bounded-command" },
      }),
    ),
    "tool_call",
  );
  expect(callArgs(poll)).toEqual({
    id: "process",
    args: { action: "poll", sessionId: "bounded-command", timeout: 30_000 },
  });
  expect(
    outputText(
      await turn.complete(
        poll,
        catalogOutput("process", {
          content: [{ type: "text", text: "(no new output)\n\nProcess exited with code 0." }],
          details: { status: "completed", sessionId: "bounded-command", exitCode: 0 },
        }),
      ),
    ),
  ).toBe("PROGRESS_OK");
});

it("binds crossed same-case catalog responses to their matching workers", async () => {
  const server = await startMockServer();
  const childKey = (n: number) => `agent:qa:subagent:child-${n}`;
  const parentId = (n: number) => `qa-terminal-parent-${n}`;
  const startChild = (n: number) =>
    postResponses(server, {
      stream: false,
      model: "gpt-5.6-luna",
      instructions: `Runtime: embedded\n- Your session: ${childKey(n)}.`,
      client_metadata: { session_id: `qa-terminal-child-${n}` },
      input: [makeUserInput("Subagent terminal reply QA worker: visible.")],
    });
  const acknowledgeParent = async (n: number) => {
    const input: unknown[] = [makeUserInput("Subagent terminal reply QA check: visible.")];
    const body = {
      model: "gpt-5.6-luna",
      tools: catalogTools,
      instructions: `Runtime: embedded | agent=qa | session=agent:qa:${parentId(n)}`,
      client_metadata: { session_id: parentId(n) },
      input,
    };
    const call = outputToolCall(await expectNonStreamingResponsesJson(server, body), "tool_call");
    expect(callArgs(call)).toMatchObject({ id: "sessions_spawn" });
    const callId = String(call.call_id);
    input.push(
      call,
      makeToolOutputWithCallId(
        callId,
        catalogOutput("sessions_spawn", {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "accepted",
                childSessionKey: childKey(n),
                runId: `run-${callId}`,
              }),
            },
          ],
        }),
      ),
    );
    expect(outputText(await expectNonStreamingResponsesJson(server, body))).toBe("Worker started.");
  };
  const settleParent = (n: number) =>
    server.terminalRequesters.settle({
      call: async () => ({
        sessions: [
          {
            key: `agent:qa:${parentId(n)}`,
            agentId: "qa",
            sessionId: parentId(n),
            hasActiveRun: false,
            status: "done",
            abortedLastRun: false,
          },
        ],
      }),
    });
  const settled: number[] = [];
  const first = startChild(1).then((response) => {
    settled.push(1);
    return response;
  });
  const second = startChild(2).then((response) => {
    settled.push(2);
    return response;
  });
  await expect
    .poll(async () => (await getJson<unknown[]>(server, "/debug/inflight-requests")).length)
    .toBe(2);
  await acknowledgeParent(2);
  expect(settled).toEqual([]);
  await settleParent(2);
  expect(outputText(await (await expectOk(second)).json())).toBe("QA-SUBAGENT-TERMINAL-VISIBLE-OK");
  expect(settled).toEqual([2]);
  await acknowledgeParent(1);
  expect(settled).toEqual([2]);
  await settleParent(1);
  expect(outputText(await (await expectOk(first)).json())).toBe("QA-SUBAGENT-TERMINAL-VISIBLE-OK");
  expect(settled).toEqual([2, 1]);
});
