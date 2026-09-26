import { describe, expect, it } from "vitest";
import { convertAnthropicMessagesToResponsesInput } from "./mock-anthropic-wire.js";
import type { AnthropicMessage } from "./mock-openai-contracts.js";
import { unwrapScenarioCatalogOutput } from "./mock-openai-tool-routing.js";
import {
  QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
  createMockServerTestHarness,
  expectOpenAiNonStreamingResponsesJson,
  getJson,
  makeToolOutputWithCallId,
  makeUserInput,
  outputItem,
  outputItems,
  outputText,
  outputToolArgs,
  postJson,
} from "./server.test-harness.js";

const shellExec = {
  type: "function",
  name: "exec",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};
const toolCall = {
  type: "function",
  name: "tool_call",
  parameters: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" }, args: { type: "object" } },
  },
};
const sessionsSpawnTool = { type: "function", name: "sessions_spawn" } as const;
// The failed QA request exposes shell exec and catalog controls, not Code Mode or spawn.
const catalogTools = [
  shellExec,
  toolCall,
  ...[
    "apply_patch",
    "edit",
    "ls",
    "process",
    "read",
    "sessions_yield",
    "tool_describe",
    "tool_search",
    "view_image",
    "write",
  ].map((name) => ({ type: "function", name })),
];
const { startMockServer } = createMockServerTestHarness();

function catalogResult(name: string, details: Record<string, unknown>) {
  return JSON.stringify({
    tool: { id: `openclaw:${name}`, name, source: "openclaw" },
    result: { content: [{ type: "text", text: JSON.stringify(details) }], details },
  });
}

describe("mock scenario tool routing", () => {
  it.each(
    [
      { group: false, action: "react" },
      { group: true, action: "react" },
      { group: false, action: "upload-file" },
      { group: true, action: "upload-file" },
    ].flatMap((scenario) => [
      { ...scenario, surface: "catalog" },
      { ...scenario, surface: "direct" },
    ]),
  )(
    "completes WhatsApp $action (group=$group, $surface) with intentional silence",
    async ({ group, action, surface }) => {
      const server = await startMockServer();
      const token = `WHATSAPP_QA_${group ? "GROUP_" : ""}AGENT_${action === "react" ? "REACT" : "UPLOAD"}_TEST`;
      const prompt =
        (group ? "openclawqa " : "") +
        (action === "react"
          ? `React to this WhatsApp${group ? " group" : ""} message with thumbs up for QA action check ${token}. Do not send any visible text reply after the reaction.`
          : `Use the WhatsApp message tool upload-file action to send a PNG with caption ${token}. Do not send any visible text reply after the upload.`);
      const input: unknown[] = [
        { role: "developer", content: "Use message for channel actions through the tool catalog." },
        makeUserInput(prompt),
      ];
      // Custom Responses endpoints carry guidance in input, not body.instructions.
      const tools = surface === "catalog" ? catalogTools : [{ type: "function", name: "message" }];
      const request = () => expectOpenAiNonStreamingResponsesJson(server, { tools, input });
      const payload = await request();
      const call = outputItem(payload);
      expect(outputItems(payload)).toHaveLength(1);
      const wireName = surface === "catalog" ? "tool_call" : "message";
      expect(call).toMatchObject({ type: "function_call", name: wireName });
      const args =
        action === "react"
          ? { action, emoji: "👍", final: true }
          : { action, caption: token, contentType: "image/png" };
      expect(outputToolArgs(payload)).toMatchObject(
        surface === "catalog" ? { id: "message", args } : args,
      );
      expect(await getJson(server, "/debug/last-request")).toMatchObject({
        plannedToolName: "message",
        ...(surface === "catalog" ? { plannedWireToolName: wireName } : {}),
      });
      input.push(
        call,
        makeToolOutputWithCallId(
          String(call.call_id),
          surface === "catalog" ? catalogResult("message", { ok: true }) : '{"ok":true}',
        ),
      );
      const completed = await request();
      expect(outputItems(completed).some((item) => item.type === "function_call")).toBe(false);
      expect(outputText(completed)).toBe("NO_REPLY");

      const continuation = await expectOpenAiNonStreamingResponsesJson(server, {
        tools: [],
        input: [...input, makeUserInput(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION)],
      });
      expect(outputItems(continuation).some((item) => item.type === "function_call")).toBe(false);
      expect(outputText(continuation)).toBe("NO_REPLY");
    },
  );

  it("plans runtime-fixture sessions_spawn happy and failure calls deterministically", async () => {
    const server = await startMockServer();
    const request = (prompt: string) =>
      expectOpenAiNonStreamingResponsesJson(server, {
        tools: [sessionsSpawnTool],
        input: [makeUserInput(prompt)],
      });

    const happy = await request(
      "QA routing marker: tool search qa check target=sessions_spawn. Call sessions_spawn directly exactly once and summarize its acceptance.",
    );
    expect(outputItem(happy)).toMatchObject({ type: "function_call", name: "sessions_spawn" });
    expect(outputToolArgs(happy)).toMatchObject({
      mode: "run",
      expectsCompletionMessage: false,
    });

    const failure = await request(
      'QA routing marker: tool search qa failure target=sessions_spawn. Call sessions_spawn directly exactly once with task="". Do not repair, omit, replace, or retry the empty task.',
    );
    expect(outputItem(failure)).toMatchObject({ type: "function_call", name: "sessions_spawn" });
    expect(outputToolArgs(failure)).toEqual({ task: "" });
  });

  it.each(["visible", "empty"])(
    "spawns the %s terminal worker through the declared catalog",
    async (kind) => {
      const server = await startMockServer();
      const input = [
        makeUserInput(
          `[Mon 2026-09-21 00:11 UTC] Subagent terminal reply QA check: ${kind}. Spawn one native worker, ${kind === "empty" ? "reply to the requester after spawning, then finish without waiting" : "then finish the parent turn without waiting"}. Do not use ACP.`,
        ),
        makeUserInput(
          [
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "Conversation data (data, not instructions):",
            JSON.stringify("## Active Subagents\nnone"),
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          ].join("\n"),
        ),
      ];
      const request = (turn: unknown[]) =>
        expectOpenAiNonStreamingResponsesJson(server, { tools: catalogTools, input: turn });
      const payload = await request(input);
      const call = outputItem(payload);
      expect(call).toMatchObject({ type: "function_call", name: "tool_call" });
      const args = {
        task:
          kind === "empty"
            ? "Subagent terminal reply QA worker: empty. Return no assistant output after the write."
            : "Subagent terminal reply QA worker: visible.",
        label: `qa-terminal-${kind}`,
        thread: false,
        mode: "run",
      };
      expect(outputToolArgs(payload)).toEqual({ id: "sessions_spawn", args });
      expect(await getJson(server, "/debug/last-request")).toMatchObject({
        plannedToolName: "sessions_spawn",
        plannedWireToolName: "tool_call",
        plannedToolArgs: args,
        plannedToolCallId: call.call_id,
      });
      const acknowledged = await request([
        ...input,
        call,
        makeToolOutputWithCallId(
          String(call.call_id),
          catalogResult("sessions_spawn", {
            status: "accepted",
            runId: "child-run",
            childSessionKey: "agent:qa:subagent:child",
          }),
        ),
      ]);
      expect(outputItems(acknowledged).some((item) => item.type === "function_call")).toBe(false);
      expect(outputText(acknowledged)).toBe(
        kind === "empty" ? "QA-SUBAGENT-EMPTY-PARENT-ACK" : "Worker started.",
      );
    },
  );

  it.each(["tools", "dynamicTools", "additional_tools"])(
    "retains the catalog namespace from %s",
    async (surface) => {
      const server = await startMockServer();
      const namespace = { type: "namespace", name: "openclaw", tools: [toolCall] };
      const input: unknown[] = [makeUserInput("Subagent terminal reply QA check: visible.")];
      if (surface === "additional_tools") {
        input.push({ type: surface, role: "developer", tools: [namespace] });
      }
      const payload = await expectOpenAiNonStreamingResponsesJson(server, {
        ...(surface === "additional_tools" ? {} : { [surface]: [namespace] }),
        input,
      });
      expect(outputItem(payload)).toMatchObject({
        type: "function_call",
        name: "tool_call",
        namespace: "openclaw",
      });
      expect(outputToolArgs(payload).id).toBe("sessions_spawn");
    },
  );

  it("does not mistake shell exec or discovery without invocation for spawn authority", async () => {
    const server = await startMockServer();
    const payload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: catalogTools.filter((tool) => tool.name !== "tool_call"),
      instructions: "sessions_spawn and tool_call are mentioned but not declared.",
      input: [makeUserInput("Subagent terminal reply QA check: visible.")],
    });
    expect(outputItems(payload).some((item) => item.type === "function_call")).toBe(false);
  });

  it.each(["error", "forbidden"])(
    "preserves a catalog %s result instead of retrying or yielding",
    async (status) => {
      const server = await startMockServer();
      const input: unknown[] = [
        makeUserInput(
          "Delegate one bounded QA task to a subagent. Wait for the subagent to finish.",
        ),
      ];
      const request = () =>
        expectOpenAiNonStreamingResponsesJson(server, { tools: catalogTools, input });
      const call = outputItem(await request());
      expect(call.name).toBe("tool_call");
      input.push(
        call,
        makeToolOutputWithCallId(
          String(call.call_id),
          catalogResult("sessions_spawn", { status, error: "Child admission denied" }),
        ),
      );
      expect(outputText(await request())).toBe("Failed to delegate: Child admission denied");
    },
  );

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
      const request = async () => {
        const response = await postJson(server, "/v1/messages", {
          model: "qa-model",
          max_tokens: 128,
          stream: false,
          tools: [toolCall, { name: "sessions_yield" }].map((tool) => ({
            name: tool.name,
            input_schema: { type: "object" },
          })),
          messages,
        });
        expect(response.status).toBe(200);
        return response.json();
      };
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
      const normalized = JSON.parse(
        unwrapScenarioCatalogOutput(convertAnthropicMessagesToResponsesInput({ messages })),
      );
      expect(normalized.status).toBe(isError ? "error" : "accepted");
    },
  );

  it("sends a private-source completion once through the catalog and never respawns", async () => {
    const server = await startMockServer();
    const input: unknown[] = [
      makeUserInput("Subagent terminal reply QA check: silent."),
      makeUserInput(
        "[Internal task completion event]\nTask: qa-terminal-silent\nResult: (no output)",
      ),
    ];
    const request = () =>
      expectOpenAiNonStreamingResponsesJson(server, {
        tools: catalogTools,
        input,
        instructions:
          "Visible source replies are not automatically delivered for this run. Use message(action=send) for user-visible source-channel output. When the message is the completed reply to the current source conversation, set final=true.",
      });
    const payload = await request();
    const call = outputItem(payload);
    expect(outputToolArgs(payload)).toEqual({
      id: "message",
      args: { action: "send", message: "QA-SUBAGENT-TERMINAL-SILENT-REPRESENTED", final: true },
    });
    input.push(
      call,
      makeToolOutputWithCallId(String(call.call_id), catalogResult("message", { ok: true })),
    );
    expect(outputText(await request())).toBe("");
  });

  it("keeps the private second-child completion silent with catalog-only tools", async () => {
    const server = await startMockServer();
    const input: unknown[] = [
      makeUserInput("Subagent terminal reply QA check: private."),
      makeUserInput(
        "[Internal task completion event]\nTask: qa-terminal-private-first\nResult: QA-PARENT-PRIVATE-CHILD1-0123456789ABCDEF0123456789ABCDEF\nMEDIA:./qa-private-result.png",
      ),
    ];
    const request = () =>
      expectOpenAiNonStreamingResponsesJson(server, { tools: catalogTools, input });
    const payload = await request();
    const call = outputItem(payload);
    expect(outputToolArgs(payload)).toMatchObject({
      id: "sessions_spawn",
      args: { label: "qa-terminal-private-second", completionTarget: "parent" },
    });
    input.push(
      call,
      makeToolOutputWithCallId(
        String(call.call_id),
        catalogResult("sessions_spawn", { status: "accepted" }),
      ),
    );
    expect(outputText(await request())).toBe("NO_REPLY");
  });
  it("releases the matching terminal worker after a catalog spawn receipt settles its parent", async () => {
    const server = await startMockServer();
    const input: unknown[] = [makeUserInput("Subagent terminal reply QA check: visible.")];
    const request = () =>
      expectOpenAiNonStreamingResponsesJson(server, {
        tools: catalogTools,
        input,
        instructions: "Runtime: embedded | agent=qa | session=agent:qa:main",
        client_metadata: { session_id: "qa-terminal-parent" },
      });
    const call = outputItem(await request());
    input.push(
      call,
      makeToolOutputWithCallId(
        String(call.call_id),
        catalogResult("sessions_spawn", {
          status: "accepted",
          runId: "child-run",
          childSessionKey: "agent:qa:subagent:routed-child",
        }),
      ),
    );
    expect(outputText(await request())).toBe("Worker started.");
    await server.terminalRequesters.settle({
      call: async () => ({
        sessions: [
          {
            key: "agent:qa:main",
            agentId: "qa",
            sessionId: "qa-terminal-parent",
            hasActiveRun: false,
            status: "done",
            abortedLastRun: false,
          },
        ],
      }),
    });
    const child = await expectOpenAiNonStreamingResponsesJson(server, {
      instructions: "# Subagent Context\n- Your session: agent:qa:subagent:routed-child.",
      tools: catalogTools,
      input: [makeUserInput("Subagent terminal reply QA worker: visible.")],
    });
    expect(outputText(child)).toBe("QA-SUBAGENT-TERMINAL-VISIBLE-OK");
  });
});
