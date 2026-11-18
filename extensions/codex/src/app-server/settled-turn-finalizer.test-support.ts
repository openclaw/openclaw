import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, vi } from "vitest";
import plugin from "../../index.js";
import * as boundedTurn from "./bounded-turn.js";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
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
import {
  attachCodexMirrorAttestation,
  fingerprintCodexMirrorSourceMessage,
  isMirroredAgentMessage,
} from "./transcript-mirror-attestation.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";

export { registerCodexEventProjectorTestLifecycle } from "./event-projector.test-harness.js";

export async function createCodexSettledFinalizerTestFixture(
  options: { failedTool?: boolean; terminalStatus?: "failed" | "completed" } = {},
) {
  const runBounded = vi
    .spyOn(boundedTurn, "runBoundedCodexAppServerTurn")
    .mockImplementation(vi.fn<typeof boundedTurn.runBoundedCodexAppServerTurn>());
  const mirror = vi
    .spyOn(codexTranscriptMirrorRuntime, "mirror")
    .mockImplementation(async (input) => ({
      assistantMirrorIdentitiesOwned: input.terminalAssistantOwner
        ? [input.terminalAssistantOwner.mirrorIdentity]
        : [],
      anchorsByMirrorIdentity: new Map(),
      messagesPresent: input.messages
        .filter(isMirroredAgentMessage)
        .map((message) =>
          attachCodexMirrorAttestation(
            Object.assign({}, message, { idempotencyKey: `${input.idempotencyScope}:assistant` }),
            fingerprintCodexMirrorSourceMessage(message),
          ),
        )
        .filter(isMirroredAgentMessage),
      userMessageReceipts: [],
    }));
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
  const emit = (...args: Parameters<typeof forCurrentTurn>) =>
    projector.handleNotification(forCurrentTurn(...args));
  const completed = options.terminalStatus === "completed";
  const { durationMs, ...command } = createNativeCommandItem({
    id: "command-settled",
    command: "printf 'settled'",
    aggregatedOutput: "settled",
    durationMs: 1,
  });
  await emit("item/started", {
    item: { ...command, status: "inProgress", aggregatedOutput: null, exitCode: null },
  });
  await emit("item/completed", {
    item: {
      ...command,
      status: options.failedTool ? "failed" : "completed",
      aggregatedOutput: options.failedTool ? "command failed" : "settled",
      exitCode: options.failedTool ? 1 : 0,
      durationMs,
    },
  });
  await emit("turn/completed", {
    turn: {
      id: TURN_ID,
      status: options.terminalStatus ?? "failed",
      items: [],
      error: completed
        ? null
        : { message: "Provider overloaded", codexErrorInfo: "serverOverloaded" },
    },
  });
  expect(projector.settledTurnFailureFinalizationAllowed).toBe(!completed);
  const attempt = projector.buildResult(buildEmptyToolTelemetry());
  await projector.closeProjection();
  attempt.settledTurnFinalizationContext = new CodexSettledTurnContext(
    projectSettledCodexMessages(attempt.messagesSnapshot),
    { model: params.modelId, modelProvider: "openai" },
  );
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
