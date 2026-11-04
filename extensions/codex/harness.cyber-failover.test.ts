import { vi } from "vitest";
import {
  buildEmptyToolTelemetry,
  createParams,
  createProjector,
  expect,
  forCurrentTurn,
  it,
  registerCodexEventProjectorTestLifecycle,
  turnCompleted,
  TURN_ID,
} from "./src/app-server/event-projector.test-harness.js";
import type { runCodexAppServerAttempt } from "./src/app-server/run-attempt.js";

const runAttempt = vi.hoisted(() => vi.fn<typeof runCodexAppServerAttempt>());
vi.mock("./src/app-server/run-attempt.js", () => ({ runCodexAppServerAttempt: runAttempt }));

import { createCodexAppServerAgentHarness } from "./harness.js";
import { CodexAccessProgramUnavailableError } from "./src/app-server/access-program.js";
import { attemptTerminal } from "./src/app-server/attempt-terminal.js";
import { testCodexAppServerBindingStore } from "./src/app-server/session-binding.test-helpers.js";

registerCodexEventProjectorTestLifecycle();

const PRIMARY = "gpt-5.6-sol";
const FALLBACK = PRIMARY;

type AttemptParams = Awaited<ReturnType<typeof createParams>>;

async function refused(agentId: string, sessionId = "first") {
  const params = await createParams();
  const config = { appServer: { cyberFailover: { mode: "auto" as const } } };
  const request = {
    ...params,
    agentId,
    authProfileId: "synthetic-profile",
    sessionId,
    modelId: PRIMARY,
    model: { ...params.model, id: PRIMARY, name: PRIMARY },
    config: { plugins: { entries: { codex: { config } } } },
    onAgentEvent: vi.fn(),
  };
  const refusal = await turnResult(request);
  request.onAgentEvent.mockClear();
  return { params: request, refusal };
}

async function turnResult(
  params: AttemptParams,
  kind: "refused" | "denied" = "refused",
  telemetry = buildEmptyToolTelemetry(),
) {
  const projector = await createProjector(params);
  const error =
    kind === "refused"
      ? { message: "The provider refused this request.", codexErrorInfo: "cyberPolicy" }
      : { message: "Unexpected status 403: forbidden", codexErrorInfo: "other" };
  await projector.handleNotification(forCurrentTurn("error", { error, willRetry: false }));
  await projector.handleNotification(
    forCurrentTurn("turn/completed", {
      turn: { id: TURN_ID, status: "failed", items: [], error },
    }),
  );
  const result = projector.buildResult(telemetry);
  if (kind === "denied") {
    expect([result.currentAttemptAssistant, result.lastAssistant]).toEqual([undefined, undefined]);
  }
  return result;
}

function createHarness() {
  return createCodexAppServerAgentHarness({ bindingStore: testCodexAppServerBindingStore });
}

function expectNotice(onAgentEvent: ReturnType<typeof vi.fn>, state: "unavailable" | "escalated") {
  expect(onAgentEvent).toHaveBeenCalledWith({
    stream: "notice",
    data: {
      phase: "provider_policy",
      category: "cyber",
      state,
      provider: "openai",
      model: PRIMARY,
      fallbackModel: FALLBACK,
    },
  });
}

function expectModelCalls(...models: string[]) {
  expect(runAttempt.mock.calls.map(([, options]) => options.runtimeModelId)).toEqual(models);
}

it.each(["spawn", "abort"])("retains denied fallback after %s", async (effect) => {
  const { params, refusal } = await refused(`acted-${effect}`);
  const telemetry = buildEmptyToolTelemetry();
  if (effect === "spawn") {
    telemetry.acceptedSessionSpawns = [{ runId: "child", childSessionKey: "agent:a:subagent:c" }];
  }
  const denied = await turnResult(params, "denied", telemetry);
  if (effect === "abort") {
    denied.terminal = attemptTerminal.normalize({
      aborted: true,
      promptError: "Unexpected status 403: forbidden",
      promptErrorSource: "prompt",
    });
  }
  runAttempt.mockReset().mockResolvedValueOnce(refusal).mockResolvedValueOnce(denied);
  await expect(createHarness().runAttempt?.(params)).resolves.toBe(denied);
  expect(runAttempt).toHaveBeenCalledTimes(2);
  expectNotice(params.onAgentEvent, "unavailable");
});

it("retains read-only tool progress before a fallback authorization failure", async () => {
  const { params, refusal } = await refused("read-only-progress");
  const projector = await createProjector(params);
  const tool = { callId: "read-1", tool: "read" };
  projector.recordDynamicToolCall({ ...tool, arguments: { path: "a.txt" } });
  projector.recordDynamicToolResult({
    ...tool,
    success: true,
    contentItems: [{ type: "inputText", text: "Synthetic file contents" }],
  });
  const error = { message: "Unexpected status 403: forbidden", codexErrorInfo: "other" };
  await projector.handleNotification(
    forCurrentTurn("turn/completed", {
      turn: { id: TURN_ID, status: "failed", items: [], error },
    }),
  );
  const denied = projector.buildResult(buildEmptyToolTelemetry());
  expect(denied.replayMetadata?.replaySafe).toBe(true);
  expect(denied.toolMetas).toHaveLength(1);
  runAttempt.mockReset().mockResolvedValueOnce(refusal).mockResolvedValueOnce(denied);
  await expect(createHarness().runAttempt?.(params)).resolves.toBe(denied);
  expect(runAttempt).toHaveBeenCalledTimes(2);
});

it.each(["continuation", "abort"])("does not replay a primary refusal after %s", async (cause) => {
  const { params, refusal } = await refused(`primary-${cause}`);
  if (cause === "continuation") {
    refusal.runtimeContinuationStarted = true;
    expect(refusal.replayMetadata?.replaySafe).toBe(true);
  } else {
    refusal.terminal = attemptTerminal.normalize({ aborted: true, promptErrorSource: "prompt" });
  }
  runAttempt.mockReset().mockResolvedValue(refusal);
  await expect(createHarness().runAttempt?.(params)).resolves.toBe(refusal);
  expect(runAttempt).toHaveBeenCalledTimes(1);
});

it("keeps the refusal and avoids repeating a target denied before assistant output", async () => {
  const { params: firstParams, refusal } = await refused("denied");
  const { params: nextParams, refusal: nextRefusal } = await refused("denied", "next");
  const denied = await turnResult(firstParams, "denied");
  expect(denied.terminal).toMatchObject({ kind: "failed", source: "prompt" });
  runAttempt
    .mockReset()
    .mockResolvedValueOnce(refusal)
    .mockResolvedValueOnce(denied)
    .mockResolvedValueOnce(nextRefusal)
    .mockResolvedValue(denied);
  const harness = createHarness();

  await expect(harness.runAttempt?.(firstParams)).resolves.toBe(refusal);
  await expect(harness.runAttempt?.(nextParams)).resolves.toBe(nextRefusal);
  expectModelCalls(PRIMARY, FALLBACK, PRIMARY);
  expect(runAttempt.mock.calls[1]?.[0]).toEqual({
    ...firstParams,
    suppressNextUserMessagePersistence: true,
    cyberAccessProgram: "daybreak_blue",
  });
  for (const params of [firstParams, nextParams]) {
    expectNotice(params.onAgentEvent, "unavailable");
    expect(params.model.id).toBe(PRIMARY);
  }

  const { params: otherParams, refusal: otherRefusal } = await refused("other", "other");
  const answeredProjector = await createProjector(otherParams);
  await answeredProjector.handleNotification(
    turnCompleted([{ type: "agentMessage", id: "reply", text: "Synthetic fallback reply" }]),
  );
  const answer = answeredProjector.buildResult(buildEmptyToolTelemetry());
  runAttempt.mockReset().mockResolvedValueOnce(otherRefusal).mockResolvedValueOnce(answer);

  await expect(harness.runAttempt?.(otherParams)).resolves.toBe(answer);
  expectModelCalls(PRIMARY, FALLBACK);
  expectNotice(otherParams.onAgentEvent, "escalated");
});

it.each(["standard", "daybreak_blue", "daybreak_red"] as const)(
  "does not retry %s Access",
  async (cyberAccessProgram) => {
    const { params, refusal } = await refused("elevated-" + cyberAccessProgram);
    params.cyberAccessProgram = cyberAccessProgram;
    runAttempt.mockReset().mockResolvedValue(refusal);
    await expect(createHarness().runAttempt?.(params)).resolves.toBe(refusal);
    expect(runAttempt).toHaveBeenCalledTimes(1);
  },
);

it("keeps the original refusal when the same account has no Blue grant", async () => {
  const { params, refusal } = await refused("no-blue-grant");
  runAttempt
    .mockReset()
    .mockResolvedValueOnce(refusal)
    .mockRejectedValueOnce(
      new CodexAccessProgramUnavailableError("Blue is not advertised for this account"),
    );
  await expect(createHarness().runAttempt?.(params)).resolves.toBe(refusal);
  expectModelCalls(PRIMARY, PRIMARY);
  expectNotice(params.onAgentEvent, "unavailable");
});
