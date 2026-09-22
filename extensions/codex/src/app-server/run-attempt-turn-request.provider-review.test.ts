import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexTurn, CodexUserInput } from "./protocol.js";
import { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";

const cleanup = vi.hoisted(() => ({ interrupt: vi.fn(), retire: vi.fn() }));
const references = vi.hoisted(() => ({
  delivered: false,
  accepted: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  embeddedAgentLog: { debug: vi.fn(), warn: vi.fn() },
  formatErrorMessage: String,
}));
vi.mock("./attempt-client-cleanup.js", () => ({
  interruptCodexTurnAndWaitBestEffort: cleanup.interrupt,
  retireUnsafeCodexTurnClientBestEffort: cleanup.retire,
}));
vi.mock("./attempt-diagnostics.js", () => ({
  createCodexModelCallDiagnosticEmitter: () => ({ setRequestPayloadBytes: vi.fn() }),
  utf8JsonByteLength: () => 1,
}));
vi.mock("./binding-connection.js", () => ({ assertCodexSessionRuntimeOwnership: vi.fn() }));
vi.mock("./client-runtime.js", () => ({
  prepareCodexWorkspaceReferences: () => ({
    include: !references.delivered,
    accepted: () => {
      references.delivered = true;
      references.accepted();
    },
  }),
}));
vi.mock("./client.js", () => ({
  isCodexAppServerIndeterminateRequestCancellationError: () => false,
}));
vi.mock("./explicit-skill-input.js", () => ({ resolveCodexExplicitSkillInputs: async () => [] }));
vi.mock("./inference-routing.js", () => ({ getCodexInferenceThread: () => undefined }));
vi.mock("./protocol-validators.js", () => ({
  assertCodexTurnStartResponse: (response: unknown) => response,
}));
vi.mock("./rate-limit-cache.js", () => ({ readCodexRateLimitsRevision: () => 0 }));
vi.mock("./run-attempt-lifecycle.js", () => ({
  emitCodexAppServerEvent: vi.fn(),
  withCodexAppServerFastModeServiceTier: (value: unknown) => value,
}));
vi.mock("./run-attempt-state.js", () => ({ joinPresentSections: () => "developer instructions" }));
vi.mock("./thread-lifecycle.js", () => ({
  buildTurnStartParams: (_params: unknown, options: { threadId: string; promptText: string }) => ({
    threadId: options.threadId,
    input: [{ type: "text", text: options.promptText, text_elements: [] }],
  }),
}));
vi.mock("./trajectory.js", () => ({ recordCodexTrajectoryContext: vi.fn() }));
vi.mock("./transcript-mirror.js", () => ({ buildCodexUserPromptMessage: vi.fn() }));
vi.mock("./turn-params.js", () => ({ buildCodexParentLocalInstructions: vi.fn() }));

beforeEach(() => {
  references.delivered = false;
  references.accepted.mockClear();
  cleanup.interrupt.mockReset().mockResolvedValue(true);
  cleanup.retire.mockReset().mockResolvedValue(undefined);
});

type Acknowledgment = NonNullable<AgentHarnessAttemptParamsV2["providerReviewAcknowledgment"]>;
const findings = {
  explanation: "Review the intended operation.",
  continuation: { message: "literal steer" },
};
function createAcknowledgment() {
  let phase: "pending" | "accepted" = "pending";
  const acceptNativeTurn = vi.fn<Acknowledgment["acceptNativeTurn"]>((accepted) => {
    accepted.assertCurrent();
    phase = "accepted";
    return Promise.resolve();
  });
  const methods: Pick<Acknowledgment, "read" | "assertRuntime" | "acceptNativeTurn"> = {
    read: () => ({
      phase,
      review: {
        id: "original-review",
        sessionId: "session",
        runId: "failed-run",
        provider: "openai",
        model: "test-model",
        runtimeId: "codex",
        api: "openai-chatgpt-responses",
        nativeThreadId: "same-thread",
        nativeTurnId: "failed-turn",
        review: findings,
      },
    }),
    assertRuntime: (runtime) => {
      runtime.assertCurrent();
      return Promise.resolve();
    },
    acceptNativeTurn,
  };
  // Only the host can issue this opaque object; this fixture supplies its public method contract.
  return { acknowledgment: Object.freeze(methods) as Acknowledgment, acceptNativeTurn };
}
function createNativeThread(): { latest: CodexTurn } {
  return {
    latest: {
      id: "failed-turn",
      status: "failed",
      items: [],
      error: {
        message: "Paused",
        codexErrorInfo: "misalignmentPolicyViolation",
        misalignment: {
          detailedExplanation: findings.explanation,
          steer: findings.continuation,
        },
      },
    },
  };
}
async function prepare(acknowledgment?: Acknowledgment, native = createNativeThread()) {
  const request = vi.fn(
    (
      method: string,
      _payload: { input?: CodexUserInput[] },
      options: { assertCurrent?: () => void },
    ) => {
      options.assertCurrent?.();
      if (method === "thread/turns/list") {
        return Promise.resolve({ data: [native.latest] });
      }
      if (method === "turn/start") {
        native.latest = { id: "new-turn", status: "inProgress", items: [] };
        return Promise.resolve({ turn: native.latest });
      }
      throw new Error(`Unexpected fixture method: ${method}`);
    },
  );
  const client = { request, addNotificationHandler: () => () => {} };
  const releaseCurrentRoute = vi.fn();
  const turnState = { codexTurnPromptText: "" };
  const resources = {
    state: {
      client,
      thread: { threadId: "same-thread", lifecycle: { action: "started" } },
      codexExecutionCwd: "/synthetic/workspace",
    },
    releaseCurrentRoute,
    prompt: {
      turnState,
      codexModelInputHistoryMessages: [],
      contextImageGroups: [],
      buildRenderedCodexDeveloperInstructions: () => "developer instructions",
      refreshWorkspaceReferences: (include: boolean) => {
        turnState.codexTurnPromptText = include ? "workspace reference\nuser input" : "user input";
      },
      context: {
        workspaceBootstrapContext: { promptContext: "workspace reference" },
        attemptTools: { tools: [], toolBridge: { availableTools: [], availableSpecs: [] } },
        runtime: {
          runtimeParams: { model: { api: "openai-chatgpt-responses" } },
          connection: {
            params: {
              runId: "run",
              sessionId: "session",
              provider: "openai",
              modelId: "test-model",
              model: { api: "openai-chatgpt-responses" },
              ...(acknowledgment ? { providerReviewAcknowledgment: acknowledgment } : {}),
            },
            mutable: { pluginAppServer: {} },
            appServer: { start: { transport: "stdio" } },
            usesSupervisionConnection: true,
            runAbortController: new AbortController(),
            assertCurrent: vi.fn(),
          },
        },
      },
    },
  } as unknown as Parameters<typeof prepareCodexAttemptTurnRequest>[0];
  const turnRuntime = { state: {} } as Parameters<typeof prepareCodexAttemptTurnRequest>[1];
  const prepared = await prepareCodexAttemptTurnRequest(
    resources,
    turnRuntime,
    async () => ({ armTurn: vi.fn(), cancelTurn: vi.fn() }),
    async () => true,
  );
  return { prepared, request, client, releaseCurrentRoute, resources };
}
async function start(acknowledged: boolean) {
  const attempt = await prepare(acknowledged ? createAcknowledgment().acknowledgment : undefined);
  await attempt.prepared.startCodexTurn();
  return attempt.request.mock.calls.find(([method]) => method === "turn/start")?.[1].input;
}

describe("native acknowledged turn requests", () => {
  it.each([true, false])(
    "reconciles an accepted turn when host clear fails, then rejects a fresh old-review acknowledgment (interrupt confirmed: %s)",
    async (interrupted) => {
      const native = createNativeThread();
      const firstHost = createAcknowledgment();
      firstHost.acceptNativeTurn.mockRejectedValueOnce(
        new Error("RPC diagnostic containing the literal steer"),
      );
      const first = await prepare(firstHost.acknowledgment, native);
      cleanup.interrupt.mockImplementationOnce(async () => {
        if (interrupted) {
          native.latest = { ...native.latest, status: "interrupted" };
        }
        return interrupted;
      });
      const failure = await first.prepared.startCodexTurn().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(formatErrorMessage(failure)).toBe(
        "Could not continue this chat. Review its latest status before trying again.",
      );
      expect(first.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
        1,
      );
      expect(cleanup.interrupt).toHaveBeenCalledExactlyOnceWith(first.client, {
        threadId: "same-thread",
        turnId: "new-turn",
      });
      expect(first.resources.state.startupClientUnsafe).toBe(!interrupted);
      expect(cleanup.retire).toHaveBeenCalledTimes(interrupted ? 0 : 1);
      if (!interrupted) {
        expect(cleanup.retire).toHaveBeenCalledWith(first.client, "startup interrupt");
      }
      expect(first.releaseCurrentRoute).toHaveBeenCalledOnce();
      expect(firstHost.acknowledgment.read().phase).toBe("pending");

      const freshHost = createAcknowledgment();
      expect(freshHost.acknowledgment).not.toBe(firstHost.acknowledgment);
      const second = await prepare(freshHost.acknowledgment, native);
      await expect(second.prepared.startCodexTurn()).rejects.toThrow(
        "native provider review changed",
      );
      expect(second.request.mock.calls.map(([method]) => method)).toEqual(["thread/turns/list"]);
      expect(freshHost.acceptNativeTurn).not.toHaveBeenCalled();
      expect(cleanup.interrupt).toHaveBeenCalledTimes(1);
    },
  );

  it("retains unsent workspace references for the next ordinary turn", async () => {
    expect(await start(true)).toEqual([{ type: "text", text: "literal steer", text_elements: [] }]);
    expect(references.accepted).not.toHaveBeenCalled();
    expect(await start(false)).toEqual([
      { type: "text", text: "workspace reference\nuser input", text_elements: [] },
    ]);
    expect(references.accepted).toHaveBeenCalledOnce();
    expect(await start(false)).toEqual([{ type: "text", text: "user input", text_elements: [] }]);
    expect(references.accepted).toHaveBeenCalledOnce();
  });
});
