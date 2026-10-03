import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, vi } from "vitest";
import plugin from "../../index.js";
import * as boundedTurn from "./bounded-turn.js";
import {
  buildEmptyToolTelemetry,
  createParams,
  createProjector,
  forCurrentTurn,
  TURN_ID,
} from "./event-projector.test-harness.js";
import { CodexSettledTurnContext } from "./settled-turn-context.js";
import { projectSettledCodexMessages } from "./settled-turn-projection.js";
import { createCodexRuntimePlanFixture } from "./thread-lifecycle.test-fixtures.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";

export { registerCodexEventProjectorTestLifecycle } from "./event-projector.test-harness.js";

export async function createCodexSettledFinalizerTestFixture(
  options: { failedTool?: boolean } = {},
) {
  const runBounded = vi
    .spyOn(boundedTurn, "runBoundedCodexAppServerTurn")
    .mockImplementation(vi.fn<typeof boundedTurn.runBoundedCodexAppServerTurn>());
  const mirror = vi.spyOn(codexTranscriptMirrorRuntime, "mirror");
  const params = await createParams();
  params.runId = "run-settled";
  params.sessionId = "session-settled";
  params.runtimePlan = createCodexRuntimePlanFixture();
  params.runtimePlan.auth = {
    providerForAuth: "openai",
    authProfileProviderForAuth: "openai",
    modelRoute: {
      provider: "openai",
      modelId: params.modelId,
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key",
      requestTransportOverrides: "none",
    },
  };
  params.resolvedApiKey = "synthetic-finalizer-key";
  params.authProfileStore = { version: 1, profiles: {} };
  params.timeoutMs = 60_000;
  const projector = await createProjector(params);
  const command = {
    type: "commandExecution",
    id: "command-settled",
    command: "printf 'settled'",
    cwd: "/workspace",
    processId: null,
    source: "agent",
    commandActions: [],
  };
  await projector.handleNotification(
    forCurrentTurn("item/started", {
      item: { ...command, status: "inProgress", aggregatedOutput: null, exitCode: null },
    }),
  );
  await projector.handleNotification(
    forCurrentTurn("item/completed", {
      item: {
        ...command,
        status: options.failedTool ? "failed" : "completed",
        aggregatedOutput: options.failedTool ? "command failed" : "settled",
        exitCode: options.failedTool ? 1 : 0,
        durationMs: 1,
      },
    }),
  );
  await projector.handleNotification(
    forCurrentTurn("turn/completed", {
      turn: {
        id: TURN_ID,
        status: "failed",
        items: [],
        error: { message: "Provider overloaded", codexErrorInfo: "serverOverloaded" },
      },
    }),
  );
  expect(projector.settledTurnFailureFinalizationAllowed).toBe(true);
  const attempt = projector.buildResult(buildEmptyToolTelemetry());
  await projector.closeProjection();
  const context = new CodexSettledTurnContext(
    projectSettledCodexMessages(attempt.messagesSnapshot),
    { model: params.modelId, modelProvider: "openai" },
  );
  attempt.settledTurnFinalizationContext = context;
  const registerAgentHarness =
    vi.fn<ReturnType<typeof createTestPluginApi>["registerAgentHarness"]>();
  plugin.register(
    createTestPluginApi({
      id: "codex",
      runtime: createPluginRuntimeMock(),
      registerAgentHarness,
    }),
  );
  expect(registerAgentHarness).toHaveBeenCalledOnce();
  return { attempt, params, harness: registerAgentHarness.mock.calls[0]![0], runBounded, mirror };
}
