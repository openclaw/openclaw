import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { buildMatrixToolProgressMentionSafetyPrompt } from "../../live-transports/matrix/scenarios/scenario-runtime-prompts.js";
import { runLoadedScenarioFlow } from "../../scenario-flow-runner.test-support.js";
import {
  buildChannelStreamingFixtureEvents,
  resolveTelegramChannelStreamingPause,
} from "./mock-openai-events.js";
import {
  anthropicCall,
  completedResult,
  functionCall,
  respond,
  textBlock,
  expectResponseText,
  expectAnthropicText,
  respondOpenAi,
  userInputs,
} from "./server.fixtures.test-support.js";
import {
  createMockServerTestHarness,
  expectAnthropicMessagesJson,
  expectOk,
  makeToolOutputWithCallId,
  outputItems,
  outputToolCall,
  postJson,
  outputText,
  postResponses,
  requireRecord,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

const EXEC_PROMPT =
  "Tool progress QA check: call the exec tool exactly once with this exact command before answering: `true`. After that command completes, reply exactly `PROGRESS_OK`.";

const ERROR_PROMPT =
  "Tool progress error QA check: read `denied.txt` before answering. After the read fails, reply exactly `PROGRESS_OK`.";

const RUNNING_OUTPUT =
  "Command still running (session lucky-slug, pid 3128). Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.";
const EXIT_ZERO = "\n\nProcess exited with code 0.";

function expectStage(payload: unknown, phase: string, text: string) {
  expect(outputItems(payload)).toMatchObject([{ type: "message", phase, content: [{ text }] }]);
}

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
  callId?: string;
};

const anthropicResult = (id: unknown, content: unknown, is_error?: boolean) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content, is_error }],
});

async function requestProgress(route: string, prompt: string, results: ProgressResult[]) {
  const server = await startMockServer();
  const responses = route === "responses";
  const input = [{ role: "user", content: responses ? [textBlock(prompt)] : prompt }];
  const history = results.flatMap<unknown>(({ tool, args, output, isError, callId }, index) => {
    const id = callId ?? `progress_${index}`;
    return responses
      ? [
          functionCall(tool, args, id),
          { type: "function_call_output", call_id: id, output, is_error: isError },
        ]
      : [anthropicCall(tool, args, id), anthropicResult(id, output, isError)];
  });
  const body = {
    model: "qa-model",
    stream: false,
    max_tokens: 256,
    [responses ? "input" : "messages"]: [...input, ...history],
  };
  return (await expectOk(postJson(server, `/v1/${route}`, body))).json();
}

it("honors the Matrix required failure after exit 0", async () => {
  const prompt = buildMatrixToolProgressMentionSafetyPrompt(
    "@qa-sut:matrix-qa.test",
    "PROGRESS_OK",
  );
  const plan = await requestProgress("messages", prompt, []);
  const command =
    "while [ ! -d 'matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.release' ]; do sleep 1; done; rmdir 'matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.release'; false";
  expect(plan.content[0]).toMatchObject({ name: "exec", input: { command } });
  const results: ProgressResult[] = [
    { tool: "exec", args: plan.content[0].input, output: [{ type: "text", text: RUNNING_OUTPUT }] },
  ];
  const pending = await requestProgress("messages", prompt, results);
  expect(pending.content).toMatchObject([{ name: "process" }]);
  results.push(pollResult(EXIT_ZERO));
  expect(await requestProgress("messages", prompt, results)).toMatchObject({
    content: [{ text: "BUG-TOOL-DID-NOT-FAIL" }],
  });
});
it("rejects empty call IDs even when command failure is allowed", async () => {
  const response = await requestProgress("messages", FAILURE_ALLOWED_PROMPT, [
    { ...execResult(RUNNING_OUTPUT), callId: "" },
    { ...pollResult(EXIT_ZERO), callId: "" },
  ]);
  expect(response).toMatchObject({ content: [{ text: "BUG-TOOL-PROGRESS-CALL-MISMATCH" }] });
});

function execResult(output: ProgressResult["output"], isError?: boolean): ProgressResult {
  return { tool: "exec", args: { command: "true" }, output, isError };
}

function pollResult(output: string, isError?: boolean, sessionId = "lucky-slug"): ProgressResult {
  return { tool: "process", args: { action: "poll", sessionId }, output, isError };
}
const polled = (output: string, isError?: boolean) => [
  execResult(RUNNING_OUTPUT),
  pollResult(output, isError),
];

const FAILURE_ALLOWED_PROMPT = EXEC_PROMPT.replace(
  "command completes,",
  "command completes or fails,",
);

const failedExec = execResult("Node: node-1\n(Command exited with code 7)", false);
it.each<[string, ProgressResult[], boolean, string]>([
  [
    "exit-like stdout",
    polled("ordinary output\nProcess exited with code 0."),
    false,
    "BUG-TOOL-DID-NOT-COMPLETE",
  ],
  ["unknown exit", polled("\n\nProcess exited with unknown exit code.", true), true, "PROGRESS_OK"],
  ["foreground failure", [failedExec], false, "BUG-TOOL-FAILED"],
  ["allowed failure", [failedExec], true, "PROGRESS_OK"],
  ["running error", [execResult(RUNNING_OUTPUT, true)], true, "BUG-TOOL-DID-NOT-COMPLETE"],
  [
    "restricted approval",
    [execResult(APPROVAL_RESTRICTED_OUTPUT, false)],
    true,
    "BUG-TOOL-DID-NOT-COMPLETE",
  ],
])("background command progress: %s", async (_name, results, allowFailure, expected) => {
  const prompt = allowFailure ? FAILURE_ALLOWED_PROMPT : EXEC_PROMPT;
  expectResponseText(await requestProgress("responses", prompt, results), expected);
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
    respond(server, input, { model: "qa-model", tools: [{ type: "function", name: "exec" }] });
  const input = userInputs(prompt);
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
  const running = [...input, call, makeToolOutputWithCallId(String(call.call_id), RUNNING_OUTPUT)];
  const poll = outputToolCall(await request(running), "process");
  expect(poll.arguments).toBe(
    JSON.stringify({ action: "poll", sessionId: "lucky-slug", timeout: 30_000 }),
  );
  const final = await request([
    ...running,
    poll,
    makeToolOutputWithCallId(String(poll.call_id), `SLACK-QA-OUTPUT-00000000${EXIT_ZERO}`),
  ]);
  expectStage(final, "final_answer", "SLACK-QA-COMMENTARY-DONE-00000000");
});

async function completeProgress(prompt: string, result: ProgressResult) {
  const plan = await requestProgress("messages", prompt, []);
  const call = plan.content[0];
  expect(call).toMatchObject({ type: "tool_use", name: result.tool, input: result.args });
  return requestProgress("messages", prompt, [{ ...result, callId: call.id }]);
}

it.each<[string, string, ProgressResult]>([
  [
    "exec stdout containing a foreign approval fence",
    EXEC_PROMPT,
    execResult(APPROVAL_OUTPUT.replaceAll("```", "````"), false),
  ],
  [
    "an empty read result",
    "Tool progress QA check: read `empty.txt` before answering. After the read completes, reply exactly `PROGRESS_OK`.",
    { tool: "read", args: { path: "empty.txt" }, output: "" },
  ],
])("finishes after %s", async (_label, prompt, result) => {
  expectAnthropicText(await completeProgress(prompt, result), "PROGRESS_OK");
});

it("rejects untyped content without failure evidence for error-progress completion", async () => {
  const response = await completeProgress(ERROR_PROMPT, {
    tool: "read",
    args: { path: "denied.txt" },
    output: "Access denied",
  });
  expectAnthropicText(response, "BUG-TOOL-DID-NOT-FAIL");
});

it("distinguishes a successful CodeMode runner from its failed read", async () => {
  const server = await startMockServer();
  const codeSchema = {
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
  };
  const tools = [
    { name: "exec", input_schema: codeSchema },
    { name: "wait", input_schema: { type: "object", properties: {} } },
  ];
  const request = (messages: unknown[]) =>
    expectAnthropicMessagesJson(server, { model: "qa-model", max_tokens: 256, tools, messages });
  const input = [{ role: "user", content: ERROR_PROMPT }];
  const plan = await request(input);
  expect(plan.content).toMatchObject([{ type: "tool_use", name: "exec" }]);
  const result = await request([
    ...input,
    { role: "assistant", content: plan.content },
    anthropicResult(
      requireRecord(plan.content[0], "tool use").id,
      completedResult({ status: "error", error: "Access denied" }),
      false,
    ),
  ]);
  expectAnthropicText(result, "PROGRESS_OK");
});

const senderEnvelope =
  'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"sender":{"id":"qa-user","name":"QA Operator","username":"qa_operator"}}\n```\n\n';

function policyFixture(count: number, marker: string, phrase: string) {
  const line = (index: number) => `${index + 1}. ${marker} ${phrase}`;
  return {
    prompt: `Write ${count} numbered plain-text lines. Every line must contain ${marker} and the words ${phrase}. Finish with a separate final line containing ${marker}-END. Do not use tools, Markdown, or explicit reply tags.`,
    expected: [...Array.from({ length: count }, (_, index) => line(index)), `${marker}-END`].join(
      "\n",
    ),
    preview: line(0),
  };
}

describe("Telegram policy hot-reload mock provider", () => {
  it("holds an incomplete preview before the final answer with timestamped sender context", async ({
    signal,
  }) => {
    const completionGate = createDeferred<void>();
    const server = await startMockServer({
      telegramChannelStreamingPause: () => completionGate.promise,
    });
    const fixture = policyFixture(
      40,
      "TG-RELOAD-root-a1b2c3d4",
      "hot reload keeps this conversation connected",
    );
    const prompt = `[Sat 2026-10-03 11:56 UTC] ${senderEnvelope}${fixture.prompt}`;
    const response = await postResponses(server, {
      model: "gpt-5.6-luna",
      stream: true,
      input: userInputs(prompt),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: Array<Record<string, unknown>> = [];
    let pending = "";
    let preview = "";
    const readEvents = async () => {
      const part = await withinTest(reader.read(), signal);
      pending += decoder.decode(part.value, { stream: !part.done });
      const frames = pending.split("\n\n");
      pending = frames.pop() ?? "";
      for (const frame of frames) {
        if (!frame.startsWith("data: {") || !frame.endsWith("}")) {
          continue;
        }
        const event = requireRecord(JSON.parse(frame.slice("data: ".length)), "SSE event");
        events.push(event);
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          preview += event.delta;
        }
      }
      return part.done;
    };
    try {
      while (preview.length < fixture.preview.length) {
        expect(await readEvents()).toBe(false);
      }
      expect(preview).toBe(fixture.preview);
      expect(events.map((event) => event.type)).not.toContain("response.output_text.done");
      expect(events.map((event) => event.type)).not.toContain("response.completed");
      completionGate.resolve();
      while (!(await readEvents())) {}
      expect(events.find((event) => event.type === "response.output_text.done")?.text).toBe(
        fixture.expected,
      );
      expect(
        outputText(events.find((event) => event.type === "response.completed")?.response),
      ).toBe(fixture.expected);
    } finally {
      completionGate.resolve();
      await reader.cancel();
    }
    expect(resolveTelegramChannelStreamingPause(prompt)).toEqual({ previewPauseMs: 3_000 });
  });

  it("answers the next turn through sender context without holding completion", async () => {
    const server = await startMockServer();
    const fixture = policyFixture(
      12,
      "TG-RELOAD-account-a1b2c3d4-NEXT",
      "new policy keeps this conversation connected",
    );
    const prompt = `[Sat 2026-10-03 11:56 UTC] ${senderEnvelope}${fixture.prompt}`;
    const response = await respondOpenAi(server, prompt);
    expect(outputText(response)).toBe(fixture.expected);
    expect(resolveTelegramChannelStreamingPause(prompt)).toBeUndefined();
  });

  it("does not capture unrelated numbered-line prompts", () => {
    for (const { prompt } of [
      policyFixture(40, "OTHER-MARKER", "hot reload keeps this conversation connected"),
      policyFixture(
        40,
        "TG-RELOAD-account-a1b2c3d4",
        "new policy keeps this conversation connected",
      ),
      policyFixture(
        12,
        "TG-RELOAD-root-a1b2c3d4-NEXT",
        "hot reload keeps this conversation connected",
      ),
    ]) {
      expect(
        buildChannelStreamingFixtureEvents({
          currentPrompt: prompt,
          allInputText: prompt,
          hasCompletedToolOutput: false,
        }),
      ).toBeUndefined();
      expect(resolveTelegramChannelStreamingPause(prompt)).toBeUndefined();
    }
  });
});
