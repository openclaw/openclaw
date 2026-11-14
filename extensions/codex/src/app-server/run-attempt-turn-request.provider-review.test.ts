import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexTurn, CodexUserInput } from "./protocol.js";
import { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import { isCodexTurnContextHandoff } from "./test-support.js";

const cleanup = vi.hoisted(() => ({ interrupt: vi.fn(), retire: vi.fn() }));
const references = vi.hoisted(() => ({ delivered: false, accepted: vi.fn() }));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
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
vi.mock("./client-runtime.js", () => ({
  prepareCodexWorkspaceReferences: () => ({
    include: !references.delivered,
    accepted: () => {
      references.delivered = true;
      references.accepted();
    },
  }),
}));
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
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
vi.mock("./developer-instruction-sections.js", () => ({
  joinPresentSections: () => "developer instructions",
}));
vi.mock("./turn-params.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./turn-params.js")>()),
  buildCodexParentLocalInstructions: vi.fn(),
  buildTurnStartParams: (_params: unknown, options: { threadId: string; promptText: string }) => ({
    threadId: options.threadId,
    input: [{ type: "text", text: options.promptText, text_elements: [] }],
  }),
}));
vi.mock("./trajectory.js", () => ({ recordCodexTrajectoryContext: vi.fn() }));
vi.mock("./user-prompt-message.js", () => ({ buildCodexUserPromptMessage: vi.fn() }));

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
  return { acknowledgment: Object.freeze(methods) as Acknowledgment, acceptNativeTurn };
}
function createNativeThread(): { latest: CodexTurn } {
  const latest: CodexTurn = {
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
  };
  return { latest };
}
async function prepare(native = createNativeThread(), usesSupervisionConnection = true) {
  const host = createAcknowledgment();
  const request = vi.fn(
    async (
      method: string,
      _payload: { threadId?: string; input?: CodexUserInput[] },
      options: { assertCurrent?: () => void },
    ) => {
      options.assertCurrent?.();
      if (method === "thread/turns/list") {
        return { data: [native.latest] };
      }
      if (method === "thread/inject_items") {
        return {};
      }
      if (method === "turn/start") {
        native.latest = { id: "new-turn", status: "inProgress", items: [] };
        return { turn: native.latest };
      }
      throw new Error(`Unexpected fixture method: ${method}`);
    },
  );
  const client = { request, addNotificationHandler: () => () => {} };
  const liveThreadOwnership = { assertCurrent: vi.fn(), release: vi.fn(), forget: vi.fn() };
  const route = { armTurn: vi.fn(), cancelTurn: vi.fn() };
  const nativeProcessAuthority = { bindTurn: vi.fn() };
  const turnState = { codexTurnPromptText: "" };
  const resources = {
    state: {
      client,
      thread: {
        threadId: "same-thread",
        lifecycle: { action: "started" },
        connectionScope: usesSupervisionConnection ? "supervision" : "managed",
        modelProvider: "openai",
        model: "test-model",
        liveThreadOwnership,
      },
    },
    releaseCurrentRoute: vi.fn(),
    nativeProcessAuthority,
    prompt: {
      turnState,
      contextImageGroups: [],
      buildRenderedCodexDeveloperInstructions: () => "developer instructions",
      refreshWorkspaceReferences: (include: boolean) => {
        turnState.codexTurnPromptText = include ? "workspace reference\nuser input" : "user input";
      },
      context: {
        workspaceBootstrapContext: { promptContext: "workspace reference" },
        attemptTools: { tools: [], toolBridge: { availableTools: [], availableSpecs: [] } },
        runtime: {
          nativeExecutionPolicy: {},
          runtimeParams: { model: { api: "openai-chatgpt-responses" } },
          connection: {
            params: {
              runId: "run",
              sessionId: "session",
              provider: "openai",
              modelId: "test-model",
              model: { api: "openai-chatgpt-responses" },
              ...(usesSupervisionConnection
                ? { providerReviewAcknowledgment: host.acknowledgment }
                : {}),
            },
            mutable: { pluginAppServer: {} },
            appServer: { start: { transport: "stdio" } },
            usesSupervisionConnection,
            runAbortController: new AbortController(),
            assertCurrent: vi.fn(),
            bindModelExecution: vi.fn(),
          },
        },
      },
    },
  } as unknown as Parameters<typeof prepareCodexAttemptTurnRequest>[0];
  const turnRuntime = { state: {} } as Parameters<typeof prepareCodexAttemptTurnRequest>[1];
  const prepared = await prepareCodexAttemptTurnRequest(
    resources,
    turnRuntime,
    async () => route,
    async () => true,
  );
  return {
    host,
    native,
    start: prepared.startCodexTurn,
    request,
    client,
    resources,
    route,
    nativeProcessAuthority,
    liveThreadOwnership,
  };
}

type SelectionChange = "thread" | "thread ID" | "owner" | "released owner" | "model" | "provider";
function changeSelection(attempt: Awaited<ReturnType<typeof prepare>>, kind: SelectionChange) {
  const { thread } = attempt.resources.state;
  if (kind === "thread") {
    attempt.resources.state.thread = { ...thread, threadId: "replacement-thread" };
  } else if (kind === "thread ID") {
    thread.threadId = "replacement-thread";
  } else if (kind === "owner") {
    thread.liveThreadOwnership = { ...attempt.liveThreadOwnership, assertCurrent: vi.fn() };
  } else if (kind === "released owner") {
    attempt.liveThreadOwnership.assertCurrent.mockImplementation(() => {
      throw new Error("Codex thread subscription ownership changed");
    });
  } else if (kind === "model") {
    thread.model = "changed-model";
  } else {
    thread.modelProvider = "changed-provider";
  }
}

type Attempt = Awaited<ReturnType<typeof prepare>>;
function changeAfterRequest(attempt: Attempt, method: string, kind: SelectionChange) {
  const request = attempt.request.getMockImplementation()!;
  attempt.request.mockImplementation(async (...args) => {
    const response = await request(...args);
    if (args[0] === method) {
      changeSelection(attempt, kind);
    }
    return response;
  });
}
function expectInterrupted(attempt: Attempt) {
  expect(cleanup.interrupt).toHaveBeenCalledExactlyOnceWith(attempt.client, {
    threadId: "same-thread",
    turnId: "new-turn",
  });
  expect(attempt.resources.releaseCurrentRoute).toHaveBeenCalledOnce();
}
function expectNotAccepted(attempt: Attempt) {
  expect(attempt.host.acceptNativeTurn).not.toHaveBeenCalled();
  expect(references.accepted).not.toHaveBeenCalled();
}
function expectOnlyReviewRead(attempt: Attempt) {
  expect(
    attempt.request.mock.calls
      .filter(
        ([method, payload]) =>
          method !== "thread/inject_items" || !isCodexTurnContextHandoff(payload),
      )
      .map(([method]) => method),
  ).toEqual(["thread/turns/list"]);
}

describe("native acknowledged turn requests", () => {
  it.each<SelectionChange>(["thread", "thread ID", "owner", "released owner", "model", "provider"])(
    "rejects a changed %s after reading the native provider review",
    async (kind) => {
      const attempt = await prepare();
      changeAfterRequest(attempt, "thread/turns/list", kind);
      await expect(attempt.start()).rejects.toThrow(/ownership changed/);
      expectOnlyReviewRead(attempt);
      expect(attempt.native.latest.status).toBe("failed");
      expectNotAccepted(attempt);
      expect(cleanup.interrupt).not.toHaveBeenCalled();
    },
  );

  it("rechecks the selected model immediately before writing turn/start", async () => {
    const attempt = await prepare();
    attempt.route.armTurn.mockImplementationOnce(() => changeSelection(attempt, "model"));
    await expect(attempt.start()).rejects.toThrow("Could not continue this chat");
    expect(attempt.native.latest.status).toBe("failed");
    expect(attempt.route.cancelTurn).toHaveBeenCalledOnce();
    expectNotAccepted(attempt);
    expect(cleanup.interrupt).not.toHaveBeenCalled();
  });

  it.each<SelectionChange>(["thread", "thread ID"])(
    "settles the dispatched thread when its %s changes before the accepted response",
    async (kind) => {
      const attempt = await prepare();
      changeAfterRequest(attempt, "turn/start", kind);
      await expect(attempt.start()).rejects.toThrow("Could not continue this chat");
      expect(attempt.nativeProcessAuthority.bindTurn).toHaveBeenCalledExactlyOnceWith(
        attempt.client,
        "same-thread",
        "new-turn",
      );
      expectInterrupted(attempt);
      expectNotAccepted(attempt);
    },
  );

  it.each([true, false])(
    "rechecks authority around host acceptance (owner released before acknowledgment: %s)",
    async (beforeAccept) => {
      const attempt = await prepare();
      const { host } = attempt;
      const accept = host.acceptNativeTurn.getMockImplementation()!;
      host.acceptNativeTurn.mockImplementationOnce(async (accepted) => {
        if (beforeAccept) {
          await Promise.resolve();
          changeSelection(attempt, "released owner");
        }
        await accept(accepted);
        if (!beforeAccept) {
          changeSelection(attempt, "model");
        }
      });
      await expect(attempt.start()).rejects.toThrow("Could not continue this chat");
      expect(host.acknowledgment.read().phase).toBe(beforeAccept ? "pending" : "accepted");
      expectInterrupted(attempt);
    },
  );

  it("selects the replacement thread on a fresh ordinary retry", async () => {
    const attempt = await prepare(createNativeThread(), false);
    const request = attempt.request.getMockImplementation()!;
    let rejectTurnStart = true;
    attempt.request.mockImplementation(async (...args) => {
      if (args[0] === "turn/start" && rejectTurnStart) {
        rejectTurnStart = false;
        throw new Error("context overflow");
      }
      return request(...args);
    });
    await expect(attempt.start()).rejects.toThrow("context overflow");
    changeSelection(attempt, "thread");
    await expect(attempt.start()).resolves.toMatchObject({
      turn: { turn: { id: "new-turn" } },
    });
    expect(
      attempt.request.mock.calls
        .filter(
          ([method, payload]) =>
            method !== "thread/inject_items" || !isCodexTurnContextHandoff(payload),
        )
        .map(([, payload]) => payload.threadId),
    ).toEqual(["same-thread", "replacement-thread"]);
    expect(references.accepted).toHaveBeenCalledOnce();
    expect(cleanup.interrupt).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "reconciles an accepted turn when host clear fails, then rejects a fresh old-review acknowledgment (interrupt confirmed: %s)",
    async (interrupted) => {
      const first = await prepare();
      const { host: firstHost, native } = first;
      firstHost.acceptNativeTurn.mockRejectedValueOnce(
        new Error("RPC diagnostic containing the literal steer"),
      );
      cleanup.interrupt.mockImplementationOnce(async () => {
        if (interrupted) {
          native.latest = { ...native.latest, status: "interrupted" };
        }
        return interrupted;
      });
      const failure = await first.start().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(formatErrorMessage(failure)).toBe(
        "Could not continue this chat. Review its latest status before trying again.",
      );
      expectInterrupted(first);
      expect(first.resources.state.startupClientUnsafe).toBe(!interrupted);
      expect(cleanup.retire).toHaveBeenCalledTimes(interrupted ? 0 : 1);
      if (!interrupted) {
        expect(cleanup.retire).toHaveBeenCalledWith(first.client, "startup interrupt");
      }
      expect(firstHost.acknowledgment.read().phase).toBe("pending");

      const second = await prepare(native);
      const { host: freshHost } = second;
      await expect(second.start()).rejects.toThrow("native provider review changed");
      expectOnlyReviewRead(second);
      expect(freshHost.acceptNativeTurn).not.toHaveBeenCalled();
      expect(cleanup.interrupt).toHaveBeenCalledTimes(1);
    },
  );
});
