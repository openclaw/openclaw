import { describe, expect, it } from "vitest";
import {
  createMockServerTestHarness,
  postResponses,
  expectResponses,
  expectNonStreamingResponsesJson,
  expectOk,
  getJson,
  outputToolCall,
  outputToolArgsFromItem,
  outputToolCallId,
  outputItems,
  outputText,
  makeUserInput,
  makeToolOutputWithCallId,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
const MESSAGE_TOOL = { type: "function", name: "message" } as const;
const STRUCTURED_CATALOG_TOOLS = ["tool_search", "tool_describe", "tool_call"].map((name) => ({
  type: "function",
  name,
}));

function catalogOutput(name: string, result: Record<string, unknown>) {
  return JSON.stringify({ tool: { id: name, name, source: "core" }, result });
}

describe("mock tool surface dispatch", () => {
  it.each([false, true])(
    "tracks a deferred command and its poll through structured results (failed=%s)",
    async (failed) => {
      const server = await startMockServer();
      const input: unknown[] = [
        makeUserInput(
          "Tool progress QA check: call the exec tool exactly once with this exact command before answering: `true`. After that command completes, reply exactly `PROGRESS_OK`.",
        ),
      ];
      const request = () =>
        expectNonStreamingResponsesJson(server, { tools: STRUCTURED_CATALOG_TOOLS, input });
      const command = outputToolCall(await request(), "tool_call");
      expect(outputToolArgsFromItem(command)).toEqual({ id: "exec", args: { command: "true" } });
      input.push(command, {
        ...makeToolOutputWithCallId(
          outputToolCallId(command, "exec"),
          JSON.stringify({
            tool: { id: "exec", name: "exec", source: "core" },
            result: {
              content: failed
                ? []
                : [
                    {
                      type: "text",
                      text: "Command still running (session bounded-command, pid 3128). Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
                    },
                  ],
              details: failed
                ? { status: "failed", exitCode: 1 }
                : {
                    status: "running",
                    sessionId: "bounded-command",
                    pid: 3128,
                    startedAt: 1,
                    cwd: "/workspace",
                    tail: "",
                    followUp:
                      "Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
                  },
            },
          }),
        ),
        is_error: failed,
      });
      if (failed) {
        expect(outputText(await request())).toBe("BUG-TOOL-FAILED");
        return;
      }
      const poll = outputToolCall(await request(), "tool_call");
      expect(outputToolArgsFromItem(poll)).toEqual({
        id: "process",
        args: { action: "poll", sessionId: "bounded-command", timeout: 30_000 },
      });
      input.push(
        poll,
        makeToolOutputWithCallId(
          outputToolCallId(poll, "poll"),
          JSON.stringify({
            tool: { id: "process", name: "process", source: "core" },
            result: {
              content: [{ type: "text", text: "(no new output)\n\nProcess exited with code 0." }],
              details: {
                status: "completed",
                sessionId: "bounded-command",
                exitCode: 0,
                aggregated: "",
              },
            },
          }),
        ),
      );
      expect(outputText(await request())).toBe("PROGRESS_OK");
    },
  );

  it("drives yielded-parent fallback through catalog spawn and namespaced yield", async () => {
    const server = await startMockServer();
    const tools = [
      ...STRUCTURED_CATALOG_TOOLS,
      {
        type: "namespace",
        name: "openclaw_direct",
        tools: [{ type: "function", name: "sessions_yield" }],
      },
    ];
    const prompt =
      "Subagent direct fallback QA check: spawn one worker and yield until QA-SUBAGENT-DIRECT-FALLBACK-OK is delivered.";
    const spawnCall = outputToolCall(
      await expectNonStreamingResponsesJson(server, {
        tools,
        input: [makeUserInput(prompt)],
      }),
      "tool_call",
    );
    const spawnArgs = outputToolArgsFromItem(spawnCall);
    expect(spawnArgs).toMatchObject({
      id: "sessions_spawn",
      args: { label: "qa-direct-fallback-worker", thread: false, mode: "run" },
    });
    expect(spawnArgs.args).not.toHaveProperty("runTimeoutSeconds");
    expect(await getJson(server, "/debug/last-request")).toMatchObject({
      plannedToolName: "sessions_spawn",
      plannedWireToolName: "tool_call",
      plannedToolArgs: spawnArgs.args,
    });
    const response = await expectResponses(server, {
      stream: true,
      tools,
      input: [
        makeUserInput(prompt),
        spawnCall,
        makeToolOutputWithCallId(
          outputToolCallId(spawnCall, "spawn"),
          JSON.stringify({
            status: "accepted",
            childSessionKey: "agent:qa:subagent:child",
            runId: "run-child-1",
          }),
        ),
      ],
    });
    const body = await response.text();
    expect(body).toContain('"name":"sessions_yield"');
    expect(body).toContain("QA-SUBAGENT-DIRECT-FALLBACK-OK");
    expect(body.match(/"namespace":"openclaw_direct"/g)).toHaveLength(3);
    expect(await getJson(server, "/debug/last-request")).toMatchObject({
      plannedToolName: "sessions_yield",
    });
  });

  it("binds crossed same-case catalog responses to their matching workers", async () => {
    const server = await startMockServer();
    const firstChildSessionKey = "agent:qa:subagent:child-1";
    const secondChildSessionKey = "agent:qa:subagent:child-2";
    const startChild = (runtimeSessionId: string, childSessionKey: string) =>
      postResponses(server, {
        stream: false,
        model: "gpt-5.6-luna",
        instructions: `Runtime: embedded\n- Your session: ${childSessionKey}.`,
        client_metadata: { session_id: runtimeSessionId },
        input: [makeUserInput("Subagent terminal reply QA worker: visible.")],
      });
    const acknowledgeParent = async (
      runtimeSessionId: string,
      childSessionKey: string,
      callId: string,
    ) => {
      const parent = await expectNonStreamingResponsesJson(server, {
        model: "gpt-5.6-luna",
        instructions: `Runtime: embedded | agent=qa | session=agent:qa:${runtimeSessionId}`,
        client_metadata: { session_id: runtimeSessionId },
        tools: STRUCTURED_CATALOG_TOOLS,
        input: [
          makeUserInput("Subagent terminal reply QA check: visible."),
          {
            type: "function_call",
            call_id: callId,
            name: "tool_call",
            arguments: JSON.stringify({ id: "sessions_spawn", args: {} }),
          },
          makeToolOutputWithCallId(
            callId,
            catalogOutput("sessions_spawn", {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "accepted",
                    childSessionKey,
                    runId: `run-${callId}`,
                  }),
                },
              ],
            }),
          ),
        ],
      });
      expect(outputText(parent)).toBe("Worker started.");
    };
    const settleParent = (runtimeSessionId: string) =>
      server.terminalRequesters.settle({
        call: async () => ({
          sessions: [
            {
              key: `agent:qa:${runtimeSessionId}`,
              agentId: "qa",
              sessionId: runtimeSessionId,
              hasActiveRun: false,
              status: "done",
              abortedLastRun: false,
            },
          ],
        }),
      });

    const firstChildResponse = startChild("qa-terminal-child-1", firstChildSessionKey);
    const secondChildResponse = startChild("qa-terminal-child-2", secondChildSessionKey);
    let firstChildSettled = false;
    let secondChildSettled = false;
    void firstChildResponse.then(() => {
      firstChildSettled = true;
    });
    void secondChildResponse.then(() => {
      secondChildSettled = true;
    });

    await expect
      .poll(async () => (await getJson<unknown[]>(server, "/debug/inflight-requests")).length)
      .toBe(2);

    await acknowledgeParent("qa-terminal-parent-2", secondChildSessionKey, "call_spawn_2");
    expect(secondChildSettled).toBe(false);
    expect(firstChildSettled).toBe(false);
    await settleParent("qa-terminal-parent-2");
    const secondChild = await (await expectOk(secondChildResponse)).json();
    expect(outputText(secondChild)).toBe("QA-SUBAGENT-TERMINAL-VISIBLE-OK");
    expect(secondChildSettled).toBe(true);
    expect(firstChildSettled).toBe(false);

    await acknowledgeParent("qa-terminal-parent-1", firstChildSessionKey, "call_spawn_1");
    expect(firstChildSettled).toBe(false);
    await settleParent("qa-terminal-parent-1");
    const firstChild = await (await expectOk(firstChildResponse)).json();
    expect(outputText(firstChild)).toBe("QA-SUBAGENT-TERMINAL-VISIBLE-OK");
  });

  it("delivers an empty terminal representation through the current message tool", async () => {
    const instructions =
      "Current source visible reply MUST use `message(action=send)`; final text is private.";
    const server = await startMockServer();
    const input: unknown[] = [
      makeUserInput("Subagent terminal reply QA check: empty."),
      {
        type: "function_call",
        call_id: "call_empty_historical_write",
        name: "write",
        arguments: '{"path":"qa-terminal-empty-side-effect.txt"}',
      },
      makeToolOutputWithCallId("call_empty_historical_write", "Wrote 40 bytes"),
      makeUserInput(
        [
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          "[Internal task completion event]\nTask: qa-terminal-empty\nResult: (no output)",
          "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        ].join("\n"),
      ),
    ];
    const request = () =>
      expectNonStreamingResponsesJson(server, { tools: [MESSAGE_TOOL], instructions, input });
    const messageCall = outputToolCall(await request(), "message");
    expect(outputToolArgsFromItem(messageCall)).toEqual({
      action: "send",
      message: "QA-SUBAGENT-TERMINAL-EMPTY-REPRESENTED",
    });
    input.push(
      messageCall,
      makeToolOutputWithCallId(
        outputToolCallId(messageCall, "call_mock_message_empty_terminal"),
        '{"ok":true,"messageId":"qa-empty-terminal"}',
      ),
    );
    const settled = await request();
    expect(outputItems(settled).some((item) => item.type === "function_call")).toBe(false);
    expect(outputText(settled)).toBe("");
  });
});
