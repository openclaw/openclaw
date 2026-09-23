import { describe, expect, it } from "vitest";
import {
  createMockServerTestHarness,
  requireRecord,
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
const SESSIONS_SPAWN_TOOL = { type: "function", name: "sessions_spawn" } as const;
const SESSIONS_YIELD_TOOL = { type: "function", name: "sessions_yield" } as const;
const MESSAGE_TOOL = { type: "function", name: "message" } as const;
const TEST_RUNTIME_CONTEXT_CARRIER = [
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
  "runtime metadata",
  "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
].join("\n");
const STRUCTURED_CATALOG_TOOLS = ["tool_search", "tool_describe", "tool_call"].map((name) => ({
  type: "function",
  name,
}));
const CODEX_DIRECT_YIELD_NAMESPACE = {
  type: "namespace",
  name: "openclaw_direct",
  tools: [SESSIONS_YIELD_TOOL],
} as const;

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

  it.each([
    {
      name: "flat tools",
      tools: [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
      namespace: undefined,
    },
    {
      name: "Codex direct-only tools",
      tools: [SESSIONS_SPAWN_TOOL, CODEX_DIRECT_YIELD_NAMESPACE],
      namespace: "openclaw_direct",
    },
    {
      name: "structured catalog tools",
      tools: [...STRUCTURED_CATALOG_TOOLS, SESSIONS_YIELD_TOOL],
      namespace: undefined,
    },
  ])("drives yielded-parent subagent fallback through $name", async ({ tools, namespace }) => {
    const server = await startMockServer();
    const prompt =
      "Subagent direct fallback QA check: spawn one worker and yield until QA-SUBAGENT-DIRECT-FALLBACK-OK is delivered.";

    const spawned = await expectNonStreamingResponsesJson(server, {
      tools,
      input: [makeUserInput(prompt)],
    });
    const structured = tools.some((tool) => tool.name === "tool_call");
    const spawnCall = outputToolCall(spawned, structured ? "tool_call" : "sessions_spawn");
    if (structured) {
      expect(outputToolArgsFromItem(spawnCall)).toMatchObject({
        id: "sessions_spawn",
        args: { label: "qa-direct-fallback-worker" },
      });
    }

    const spawnDebug = requireRecord(
      await (await fetch(`${server.baseUrl}/debug/last-request`)).json(),
      "spawn debug request",
    );
    expect(spawnDebug.plannedToolName).toBe("sessions_spawn");
    if (structured) {
      expect(spawnDebug.plannedWireToolName).toBe("tool_call");
    }
    const spawnArgs = requireRecord(spawnDebug.plannedToolArgs, "spawn planned tool args");
    expect(spawnArgs.label).toBe("qa-direct-fallback-worker");
    expect(spawnArgs.thread).toBe(false);
    expect(spawnArgs.mode).toBe("run");
    expect(spawnArgs).not.toHaveProperty("runTimeoutSeconds");

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
    if (namespace) {
      expect(body.match(new RegExp(`"namespace":"${namespace}"`, "g"))).toHaveLength(3);
    }
    const yieldDebug = requireRecord(
      await (await fetch(`${server.baseUrl}/debug/last-request`)).json(),
      "yield debug request",
    );
    expect(yieldDebug.plannedToolName).toBe("sessions_yield");
  });

  it.each([false, true])(
    "binds crossed same-case parent responses to their matching workers (structured=%s)",
    async (structured) => {
      const server = await startMockServer();
      const firstChildSessionKey = "agent:qa:subagent:child-1";
      const secondChildSessionKey = "agent:qa:subagent:child-2";
      const startChild = (runtimeSessionId: string, childSessionKey: string) =>
        postResponses(server, {
          stream: false,
          model: "gpt-5.6-luna",
          instructions: [
            `Runtime: embedded | sessionId=${runtimeSessionId}`,
            `- Your session: ${childSessionKey}.`,
          ].join("\n"),
          input: [makeUserInput("Subagent terminal reply QA worker: visible.")],
        });
      const acknowledgeParent = async (
        runtimeSessionId: string,
        childSessionKey: string,
        callId: string,
      ) => {
        const parent = await expectNonStreamingResponsesJson(server, {
          model: "gpt-5.6-luna",
          instructions: `Runtime: embedded | agent=qa | session=agent:qa:${runtimeSessionId} | sessionId=${runtimeSessionId}`,
          tools: structured ? STRUCTURED_CATALOG_TOOLS : [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
          input: [
            makeUserInput("Subagent terminal reply QA check: visible."),
            {
              type: "function_call",
              call_id: callId,
              name: structured ? "tool_call" : "sessions_spawn",
              arguments: JSON.stringify(structured ? { id: "sessions_spawn", args: {} } : {}),
            },
            makeToolOutputWithCallId(
              callId,
              JSON.stringify(
                structured
                  ? {
                      tool: { id: "sessions_spawn", name: "sessions_spawn", source: "core" },
                      result: {
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
                      },
                    }
                  : { status: "accepted", childSessionKey, runId: `run-${callId}` },
              ),
            ),
          ],
        });
        expect(outputText(parent)).toBe("Worker started.");
      };
      const settleParent = async (runtimeSessionId: string) => {
        await server.terminalRequesters.settle({
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
      };

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
        .poll(async () => {
          const inflight = await getJson<unknown[]>(server, "/debug/inflight-requests");
          return inflight.length;
        })
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
    },
  );

  it.each([
    {
      name: "OpenAI private-source guidance",
      instructions:
        "Current source visible reply MUST use `message(action=send)`; final text is private.",
      final: undefined,
    },
    {
      name: "Codex private-source guidance",
      instructions:
        "Visible source replies are not automatically delivered for this run. Use `message(action=send)` for user-visible source-channel output. When the message is the completed reply to the current source conversation, set `final=true`.",
      final: true,
    },
  ])("delivers an empty terminal representation with $name", async ({ instructions, final }) => {
    const server = await startMockServer();
    const completionInput = [
      makeUserInput("Subagent terminal reply QA check: empty."),
      {
        type: "function_call",
        call_id: "call_empty_historical_write",
        name: "write",
        arguments: '{"path":"qa-terminal-empty-side-effect.txt"}',
      },
      makeToolOutputWithCallId("call_empty_historical_write", "Wrote 40 bytes"),
      makeUserInput(
        TEST_RUNTIME_CONTEXT_CARRIER.replace(
          "runtime metadata",
          "[Internal task completion event]\nTask: qa-terminal-empty\nResult: (no output)",
        ),
      ),
    ];
    const delivery = await expectNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      instructions,
      input: completionInput,
    });
    const messageCall = outputToolCall(delivery, "message");
    expect(outputToolArgsFromItem(messageCall)).toEqual({
      action: "send",
      message: "QA-SUBAGENT-TERMINAL-EMPTY-REPRESENTED",
      ...(final ? { final } : {}),
    });

    const settled = await expectNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      instructions,
      input: [
        ...completionInput,
        messageCall,
        makeToolOutputWithCallId(
          outputToolCallId(messageCall, "call_mock_message_empty_terminal"),
          '{"ok":true,"messageId":"qa-empty-terminal"}',
        ),
      ],
    });
    expect(outputItems(settled).some((item) => item.type === "function_call")).toBe(false);
    expect(outputText(settled)).toBe("");
  });
});
