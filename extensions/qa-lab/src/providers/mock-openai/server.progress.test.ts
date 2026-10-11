import { describe, expect, it } from "vitest";
import { buildMatrixToolProgressMentionSafetyPrompt } from "../../live-transports/matrix/scenarios/scenario-runtime-prompts.js";
import { runLoadedScenarioFlow } from "../../scenario-flow-runner.test-support.js";
import {
  createMockServerTestHarness,
  expectNonStreamingResponsesJson,
  expectOk,
  makeToolOutputWithCallId,
  makeUserInput,
  outputItems,
  outputToolCall,
  postJson,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

const READ_PROMPT =
  "Tool progress QA check: read `empty.txt` before answering. After the read completes, reply exactly `PROGRESS_OK`.";
const EXEC_PROMPT =
  "Tool progress QA check: call the exec tool exactly once with this exact command before answering: `true`. After that command completes, reply exactly `PROGRESS_OK`.";
const ERROR_PROMPT =
  "Tool progress error QA check: read `denied.txt` before answering. After the read fails, reply exactly `PROGRESS_OK`.";
const RUNNING_OUTPUT =
  "Command still running (session lucky-slug, pid 3128). Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.";
const INPUT_WAIT_OUTPUT =
  "Process exited with code 7.\n\nNo new output for 16s; this session may be waiting for input. Use process write, send-keys, submit, or paste to provide input.";
const TIMED_OUT_OUTPUT =
  "\n\nProcess exited with code 0.\n\nThe command was terminated, but external side effects may already have completed. Verify the resulting state before retrying. Do not automatically rerun non-idempotent commands. Use a higher timeout only when the command is known to be safe to retry.";

const APPROVAL_OUTPUT =
  "Approval required (id abc123, full abc12345).\nHost: gateway\nCWD: /workspace\nCommand:\n```sh\ntrue\n```\nMode: foreground (interactive approvals available).\nBackground mode requires pre-approved policy (allow-always or ask=off).\nReply with: /approve abc123 allow-once|allow-always|deny\nIf the short code is ambiguous, use the full id in /approve.";
const APPROVAL_RESTRICTED_OUTPUT = APPROVAL_OUTPUT.replace(
  "Background mode requires pre-approved policy (allow-always or ask=off).",
  "Background mode requires an effective policy that allows pre-approval (for example ask=off).",
).replace(
  "allow-once|allow-always|deny\n",
  "allow-once|deny\nAllow Always is unavailable for this command.\n",
);

type ProgressResult = {
  tool: string;
  args: Record<string, unknown>;
  output: string | unknown[];
  isError?: boolean;
  callId?: string | null;
};

async function requestProgress(
  route: string,
  prompt: string,
  results: ProgressResult[],
  context?: string,
) {
  const server = await startMockServer();
  const toolResults = results.map((result, index) => ({
    ...result,
    callId: result.callId === null ? undefined : (result.callId ?? `progress_${index}`),
  }));
  const input = [prompt, ...(context ? [context] : [])].map((text) => ({
    role: "user",
    content: route === "responses" ? [{ type: "input_text", text }] : text,
  }));
  const body =
    route === "responses"
      ? {
          input: [
            ...input,
            ...toolResults.flatMap((result) => [
              {
                type: "function_call",
                name: result.tool,
                call_id: result.callId,
                arguments: JSON.stringify(result.args),
              },
              {
                type: "function_call_output",
                call_id: result.callId,
                output: result.output,
                is_error: result.isError,
              },
            ]),
          ],
        }
      : {
          messages: [
            ...input,
            ...toolResults.flatMap((result) => [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    name: result.tool,
                    id: result.callId,
                    input: result.args,
                  },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: result.callId,
                    content: result.output,
                    is_error: result.isError,
                  },
                ],
              },
            ]),
          ],
        };
  return (
    await expectOk(
      postJson(server, `/v1/${route}`, {
        model: "qa-model",
        stream: false,
        max_tokens: 256,
        ...body,
      }),
    )
  ).json();
}

describe("Anthropic command progress wire", () => {
  it.each([{ exitCode: 0, expected: "BUG-TOOL-DID-NOT-FAIL" }])(
    "honors the Matrix required failure after exit $exitCode",
    async ({ exitCode, expected }) => {
      const prompt = buildMatrixToolProgressMentionSafetyPrompt(
        "@qa-sut:matrix-qa.test",
        "PROGRESS_OK",
      );
      const plan = await requestProgress("messages", prompt, []);
      const call = plan.content[0];
      expect(call.name).toBe("exec");
      const args = call.input;
      expect(args.command).toBe(
        "while [ ! -d 'matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.release' ]; do sleep 1; done; rmdir 'matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.release'; false",
      );
      const results: ProgressResult[] = [
        {
          tool: "exec",
          args,
          output: exitCode === 1 ? RUNNING_OUTPUT : [{ type: "text", text: RUNNING_OUTPUT }],
        },
      ];
      const pending = await requestProgress("messages", prompt, results);
      expect(pending.content).toMatchObject([{ name: "process" }]);
      results.push({
        tool: "process",
        args: { action: "poll", sessionId: "lucky-slug" },
        output: `\n\nProcess exited with code ${exitCode}.`,
      });
      expect(await requestProgress("messages", prompt, results)).toMatchObject({
        content: [{ text: expected }],
      });
    },
  );
  it.each([{ label: "empty", callId: "" }])(
    "rejects $label call IDs even when command failure is allowed",
    async ({ callId }) => {
      const response = await requestProgress(
        "messages",
        EXEC_PROMPT.replace("command completes,", "command completes or fails,"),
        [
          { tool: "exec", args: { command: "true" }, output: RUNNING_OUTPUT, callId },
          {
            tool: "process",
            args: { action: "poll", sessionId: "lucky-slug" },
            output: "\n\nProcess exited with code 0.",
            callId,
          },
        ],
      );
      expect(response).toMatchObject({ content: [{ text: "BUG-TOOL-PROGRESS-CALL-MISMATCH" }] });
    },
  );
});

function execResult(output: ProgressResult["output"], isError?: boolean): ProgressResult {
  return { tool: "exec", args: { command: "true" }, output, isError };
}

function pollResult(output: string, isError?: boolean, sessionId = "lucky-slug"): ProgressResult {
  return { tool: "process", args: { action: "poll", sessionId }, output, isError };
}

const FAILURE_ALLOWED_PROMPT = EXEC_PROMPT.replace(
  "command completes,",
  "command completes or fails,",
);

describe("background command progress", () => {
  it("polls warning-prefixed output until terminal before emitting the marker", async () => {
    const results = [execResult(`Task warning\n\n${RUNNING_OUTPUT}`)];
    const expectPoll = (response: { output: Record<string, unknown>[] }) => {
      expect(response.output).toMatchObject([{ name: "process" }]);
      expect(JSON.parse(String(response.output[0]?.arguments))).toMatchObject({
        action: "poll",
        sessionId: "lucky-slug",
      });
    };
    expectPoll(await requestProgress("responses", EXEC_PROMPT, results));
    for (const output of [
      "Process exited with code 7.\n\nProcess still running.",
      INPUT_WAIT_OUTPUT,
    ]) {
      results.push(pollResult(output));
      expectPoll(await requestProgress("responses", EXEC_PROMPT, results));
    }
    results.push(
      pollResult(
        `${TIMED_OUT_OUTPUT}\n${RUNNING_OUTPUT.replace("lucky-slug", "other-session")}\n\nProcess exited with code 0.`,
      ),
    );
    expect(await requestProgress("responses", EXEC_PROMPT, results)).toMatchObject({
      output: [{ type: "message", content: [{ text: "PROGRESS_OK" }] }],
    });
  });

  it.each([
    [
      "single-newline exit-like stdout",
      pollResult("ordinary output\nProcess exited with code 0."),
      "BUG-TOOL-DID-NOT-COMPLETE",
    ],
  ] as const)("does not report success for %s", async (_label, poll, marker) => {
    const response = await requestProgress("responses", EXEC_PROMPT, [
      execResult(RUNNING_OUTPUT),
      poll,
    ]);
    expect(response).toMatchObject({ output: [{ content: [{ text: marker }] }] });
  });

  it("allows a terminal typed failure with an unknown exit code", async () => {
    const response = await requestProgress("responses", FAILURE_ALLOWED_PROMPT, [
      execResult(RUNNING_OUTPUT),
      pollResult("\n\nProcess exited with unknown exit code.", true),
    ]);
    expect(response).toMatchObject({ output: [{ content: [{ text: "PROGRESS_OK" }] }] });
  });

  it.each([{ output: "Node: node-1\n(Command exited with code 7)", isError: false }])(
    "reports foreground failure from $output",
    async ({ output, isError }) => {
      for (const allowsFailure of [false, true]) {
        const response = await requestProgress(
          "responses",
          allowsFailure ? FAILURE_ALLOWED_PROMPT : EXEC_PROMPT,
          [execResult(output, isError)],
        );
        expect(response).toMatchObject({
          output: [{ content: [{ text: allowsFailure ? "PROGRESS_OK" : "BUG-TOOL-FAILED" }] }],
        });
      }
    },
  );

  it.each([
    [
      "typed error with a running exec handle",
      [execResult(RUNNING_OUTPUT, true)],
      "BUG-TOOL-DID-NOT-COMPLETE",
    ],
    [
      "restricted approval decisions",
      [execResult(APPROVAL_RESTRICTED_OUTPUT, false)],
      "BUG-TOOL-DID-NOT-COMPLETE",
    ],
  ] as const)(
    "does not accept %s even when command failure is allowed",
    async (_label, results, marker) => {
      const response = await requestProgress("responses", FAILURE_ALLOWED_PROMPT, [...results]);
      expect(response).toMatchObject({ output: [{ content: [{ text: marker }] }] });
    },
  );
});

it("keeps Slack commentary progress open while its exec is running", async () => {
  const command =
    "printf '%s' 'SLACK-QA-TOOL-A1B2C3D4' >/dev/null; sleep 5; printf '%s\\n' 'SLACK-QA-OUTPUT-A1B2C3D4'";
  const prompt = `SLACK-QA-COMMENTARY-A1B2C3D4 ${command} SLACK-QA-COMMENTARY-DONE-A1B2C3D4`;
  const results: ProgressResult[] = [{ tool: "exec", args: { command }, output: RUNNING_OUTPUT }];
  expect(await requestProgress("responses", prompt, results)).toMatchObject({
    output: [
      {
        name: "process",
        arguments: JSON.stringify({ action: "poll", sessionId: "lucky-slug", timeout: 30_000 }),
      },
    ],
  });
  results.push({
    tool: "process",
    args: { action: "poll", sessionId: "lucky-slug" },
    output: "\n\nProcess exited with code 0.",
  });
  expect(await requestProgress("responses", prompt, results)).toMatchObject({
    output: [
      {
        type: "message",
        phase: "final_answer",
        content: [{ text: "SLACK-QA-COMMENTARY-DONE-A1B2C3D4" }],
      },
    ],
  });
});

it("selects commentary, exec, and final delivery for the actual Telegram scenario prompt", async () => {
  const server = await startMockServer();
  const captured = new Error("captured the scenario's provider input");
  let prompt = "";
  await expect(
    runLoadedScenarioFlow("telegram-progress-tool-visibility", {
      api: {
        env: {
          providerMode: "mock-openai",
          mock: server,
          gateway: { restartAfterStateMutation: async () => undefined },
        },
        fetchJson: async (url: string) => (await fetch(url)).json(),
        transport: {
          id: "telegram",
          accountId: "sut",
          reset: async () => undefined,
          sendInbound: async (input: { text: string }) => {
            prompt = input.text;
            throw captured;
          },
        },
      },
    }),
  ).rejects.toBe(captured);
  const request = (input: unknown[]) =>
    expectNonStreamingResponsesJson(server, {
      model: "qa-model",
      tools: [{ type: "function", name: "exec" }],
      input,
    });
  const input = [makeUserInput(prompt)];
  const plan = await request(input);
  expect(outputItems(plan)).toMatchObject([
    {
      type: "message",
      phase: "commentary",
      content: [{ text: "SLACK-QA-COMMENTARY-00000000" }],
    },
    { type: "function_call", name: "exec" },
  ]);
  const call = outputToolCall(plan, "exec");
  const final = await request([
    ...input,
    call,
    makeToolOutputWithCallId(
      String(call.call_id),
      "SLACK-QA-OUTPUT-00000000\n\nProcess exited with code 0.",
    ),
  ]);
  expect(outputItems(final)).toMatchObject([
    {
      type: "message",
      phase: "final_answer",
      content: [{ text: "SLACK-QA-COMMENTARY-DONE-00000000" }],
    },
  ]);
});

async function completeProgress(params: {
  prompt: string;
  tool: string;
  args: Record<string, unknown>;
  output: string | unknown[];
  isError?: boolean;
  context?: string;
}) {
  const plan = await requestProgress("messages", params.prompt, [], params.context);
  const call = plan.content[0];
  expect(call).toMatchObject({ type: "tool_use", name: params.tool, input: params.args });
  return requestProgress(
    "messages",
    params.prompt,
    [
      {
        tool: params.tool,
        args: params.args,
        output: params.output,
        isError: params.isError,
        callId: call.id,
      },
    ],
    params.context,
  );
}

describe("tool progress stdout", () => {
  it.each([
    ...[APPROVAL_OUTPUT.replaceAll("```", "````")].map((output) => ({
      label: `exec stdout containing an incomplete or foreign notice: ${output}`,
      tool: "exec",
      prompt: EXEC_PROMPT,
      output,
      isError: false,
    })),
    { label: "an empty read result", tool: "read", prompt: READ_PROMPT, output: "" },
  ])("finishes after $label", async (fixture) => {
    const response = await completeProgress({
      args: fixture.tool === "exec" ? { command: "true" } : { path: "empty.txt" },
      ...fixture,
    });
    expect(response).toMatchObject({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "PROGRESS_OK" }],
    });
  });
});

it.each([
  {
    label: "untyped content without failure evidence",
    output: "Access denied",
    isError: undefined,
    expected: "BUG-TOOL-DID-NOT-FAIL",
  },
])("uses $label for error-progress completion", async ({ expected, ...fixture }) => {
  const response = await completeProgress({
    prompt: ERROR_PROMPT,
    tool: "read",
    args: { path: "denied.txt" },
    ...fixture,
  });
  expect(response).toMatchObject({
    stop_reason: "end_turn",
    content: [{ type: "text", text: expected }],
  });
});

it("distinguishes a successful CodeMode runner from its failed read", async () => {
  const server = await startMockServer();
  const tools = [
    {
      name: "exec",
      input_schema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
    },
    { name: "wait", input_schema: { type: "object", properties: {} } },
  ];
  const request = async (messages: unknown[]) => {
    return (
      await expectOk(
        postJson(server, "/v1/messages", {
          model: "qa-model",
          max_tokens: 256,
          tools,
          messages,
        }),
      )
    ).json();
  };
  const input = [{ role: "user", content: ERROR_PROMPT }];
  const plan = await request(input);
  expect(plan.content).toMatchObject([{ type: "tool_use", name: "exec" }]);
  const result = await request([
    ...input,
    { role: "assistant", content: plan.content },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: plan.content[0].id,
          is_error: false,
          content: JSON.stringify({
            status: "completed",
            value: { status: "error", error: "Access denied" },
          }),
        },
      ],
    },
  ]);
  expect(result).toMatchObject({
    stop_reason: "end_turn",
    content: [{ type: "text", text: "PROGRESS_OK" }],
  });
});
