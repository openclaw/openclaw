import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as clientRuntime from "./client-runtime.js";
import {
  CODEX_INFERENCE_GENERATION_KEY,
  createCodexInferenceContext,
} from "./inference-context.js";
import type { CodexTurn, CodexUserInput } from "./protocol.js";
import { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import { isCodexTurnContextHandoff } from "./test-support.js";

const inference = vi.hoisted(() => ({
  route: undefined as { context: ReturnType<typeof createCodexInferenceContext> } | undefined,
}));
const cleanup = vi.hoisted(() => ({ interrupt: vi.fn(), retire: vi.fn() }));
const references = vi.hoisted(() => ({
  delivered: false,
  accepted: vi.fn(),
}));
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
vi.mock("./client-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client-runtime.js")>()),
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
vi.mock("./inference-routing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inference-routing.js")>()),
  getCodexInferenceThread: () => inference.route,
}));
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
  inference.route = undefined;
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
async function prepare(
  acknowledgment?: Acknowledgment,
  native = createNativeThread(),
  usesSupervisionConnection = true,
  onResources?: (resources: Parameters<typeof prepareCodexAttemptTurnRequest>[0]) => void,
) {
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
  const releaseCurrentRoute = vi.fn();
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
      codexExecutionCwd: "/synthetic/workspace",
    },
    releaseCurrentRoute,
    nativeProcessAuthority,
    prompt: {
      turnState,
      systemPromptReport: { injectedWorkspaceFiles: [] },
      contextImageGroups: [],
      setParentLocalEgress: vi.fn(),
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
  onResources?.(resources);
  const prepared = await prepareCodexAttemptTurnRequest(
    resources,
    turnRuntime,
    async () => route,
    async () => true,
  );
  return {
    prepared,
    request,
    client,
    releaseCurrentRoute,
    resources,
    route,
    nativeProcessAuthority,
    liveThreadOwnership,
  };
}

type SelectionChange = "thread" | "thread ID" | "owner" | "released owner" | "model" | "provider";
function changeSelection(attempt: Awaited<ReturnType<typeof prepare>>, kind: SelectionChange) {
  const { thread } = attempt.resources.state;
  switch (kind) {
    case "thread":
      attempt.resources.state.thread = { ...thread, threadId: "replacement-thread" };
      break;
    case "thread ID":
      thread.threadId = "replacement-thread";
      break;
    case "owner":
      thread.liveThreadOwnership = { ...attempt.liveThreadOwnership, assertCurrent: vi.fn() };
      break;
    case "released owner":
      attempt.liveThreadOwnership.assertCurrent.mockImplementation(() => {
        throw new Error("Codex thread subscription ownership changed");
      });
      break;
    case "model":
      thread.model = "changed-model";
      break;
    case "provider":
      thread.modelProvider = "changed-provider";
      break;
  }
}

describe("native acknowledged turn requests", () => {
  it.each<SelectionChange>(["thread", "thread ID", "owner", "released owner", "model", "provider"])(
    "rejects a changed %s after reading the native provider review",
    async (kind) => {
      const host = createAcknowledgment();
      const native = createNativeThread();
      const attempt = await prepare(host.acknowledgment, native);
      const request = attempt.request.getMockImplementation()!;
      attempt.request.mockImplementation(async (...args) => {
        const response = await request(...args);
        if (args[0] === "thread/turns/list") {
          changeSelection(attempt, kind);
        }
        return response;
      });
      await expect(attempt.prepared.startCodexTurn()).rejects.toThrow(/ownership changed/);
      expect(
        attempt.request.mock.calls
          .filter(
            ([method, payload]) =>
              method !== "thread/inject_items" || !isCodexTurnContextHandoff(payload),
          )
          .map(([method]) => method),
      ).toEqual(["thread/turns/list"]);
      expect(native.latest.status).toBe("failed");
      expect(host.acceptNativeTurn).not.toHaveBeenCalled();
      expect(references.accepted).not.toHaveBeenCalled();
      expect(cleanup.interrupt).not.toHaveBeenCalled();
    },
  );

  it("rechecks the selected model immediately before writing turn/start", async () => {
    const host = createAcknowledgment();
    const native = createNativeThread();
    const attempt = await prepare(host.acknowledgment, native);
    attempt.route.armTurn.mockImplementationOnce(() => changeSelection(attempt, "model"));
    await expect(attempt.prepared.startCodexTurn()).rejects.toThrow("Could not continue this chat");
    expect(native.latest.status).toBe("failed");
    expect(attempt.route.cancelTurn).toHaveBeenCalledOnce();
    expect(host.acceptNativeTurn).not.toHaveBeenCalled();
    expect(cleanup.interrupt).not.toHaveBeenCalled();
  });

  it.each<SelectionChange>(["thread", "thread ID"])(
    "settles the dispatched thread when its %s changes before the accepted response",
    async (kind) => {
      const host = createAcknowledgment();
      const attempt = await prepare(host.acknowledgment);
      const request = attempt.request.getMockImplementation()!;
      attempt.request.mockImplementation(async (...args) => {
        const response = await request(...args);
        if (args[0] === "turn/start") {
          changeSelection(attempt, kind);
        }
        return response;
      });
      await expect(attempt.prepared.startCodexTurn()).rejects.toThrow(
        "Could not continue this chat",
      );
      expect(attempt.nativeProcessAuthority.bindTurn).toHaveBeenCalledExactlyOnceWith(
        attempt.client,
        "same-thread",
        "new-turn",
      );
      expect(cleanup.interrupt).toHaveBeenCalledExactlyOnceWith(attempt.client, {
        threadId: "same-thread",
        turnId: "new-turn",
      });
      expect(attempt.releaseCurrentRoute).toHaveBeenCalledOnce();
      expect(host.acceptNativeTurn).not.toHaveBeenCalled();
      expect(references.accepted).not.toHaveBeenCalled();
    },
  );

  it("rejects a released live owner while the host acknowledges the accepted native turn", async () => {
    const host = createAcknowledgment();
    const attempt = await prepare(host.acknowledgment);
    const accept = host.acceptNativeTurn.getMockImplementation()!;
    host.acceptNativeTurn.mockImplementationOnce(async (accepted) => {
      await Promise.resolve();
      changeSelection(attempt, "released owner");
      await accept(accepted);
    });
    await expect(attempt.prepared.startCodexTurn()).rejects.toThrow("Could not continue this chat");
    expect(host.acknowledgment.read().phase).toBe("pending");
    expect(cleanup.interrupt).toHaveBeenCalledExactlyOnceWith(attempt.client, {
      threadId: "same-thread",
      turnId: "new-turn",
    });
    expect(attempt.releaseCurrentRoute).toHaveBeenCalledOnce();
  });

  it("preserves host acceptance if the selected model changes after acknowledgment", async () => {
    const host = createAcknowledgment();
    const attempt = await prepare(host.acknowledgment);
    const accept = host.acceptNativeTurn.getMockImplementation()!;
    host.acceptNativeTurn.mockImplementationOnce(async (accepted) => {
      await accept(accepted);
      changeSelection(attempt, "model");
    });
    await expect(attempt.prepared.startCodexTurn()).rejects.toThrow("Could not continue this chat");
    expect(host.acknowledgment.read().phase).toBe("accepted");
    expect(cleanup.interrupt).toHaveBeenCalledExactlyOnceWith(attempt.client, {
      threadId: "same-thread",
      turnId: "new-turn",
    });
    expect(attempt.releaseCurrentRoute).toHaveBeenCalledOnce();
  });

  it("selects the replacement thread on a fresh ordinary retry", async () => {
    const attempt = await prepare(undefined, createNativeThread(), false);
    const request = attempt.request.getMockImplementation()!;
    let rejectTurnStart = true;
    attempt.request.mockImplementation(async (...args) => {
      if (args[0] === "turn/start" && rejectTurnStart) {
        rejectTurnStart = false;
        throw new Error("context overflow");
      }
      return request(...args);
    });
    await expect(attempt.prepared.startCodexTurn()).rejects.toThrow("context overflow");
    changeSelection(attempt, "thread");
    await expect(attempt.prepared.startCodexTurn()).resolves.toMatchObject({
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
      expect(
        second.request.mock.calls
          .filter(
            ([method, payload]) =>
              method !== "thread/inject_items" || !isCodexTurnContextHandoff(payload),
          )
          .map(([method]) => method),
      ).toEqual(["thread/turns/list"]);
      expect(freshHost.acceptNativeTurn).not.toHaveBeenCalled();
      expect(cleanup.interrupt).toHaveBeenCalledTimes(1);
    },
  );
});

it.each(["release", "abort"])(
  "waits for root capacity before preparing a native turn: %s",
  async (outcome) => {
    const context = createCodexInferenceContext(() => {});
    inference.route = { context };
    const roots = await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        context.register({
          threadId: `saturated-${index}`,
          text: "",
          signal: new AbortController().signal,
          assertCurrent() {},
          retainPrefix: false,
        }),
      ),
    );
    const controller = new AbortController();
    let settled = false;
    const attempt = await prepare(undefined, createNativeThread(), true, (resources) => {
      const connection = resources.prompt.context.runtime.connection;
      connection.runAbortController = controller;
      connection.assertLegacyCurrent = () => {};
      connection.params.hostCapabilities = {
        assertActive() {},
      } as typeof connection.params.hostCapabilities;
    });
    const pending = attempt.prepared.startCodexTurn();
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      for (let index = 0; index < 5; index++) {
        await Promise.resolve();
      }
      expect(settled).toBe(false);
      expect(attempt.request).not.toHaveBeenCalled();
      if (outcome === "abort") {
        controller.abort(new Error("cancel waiting turn"));
        await expect(pending).rejects.toThrow("cancel waiting turn");
      } else {
        roots[0]!.release();
        await pending;
        expect(attempt.request).toHaveBeenCalledWith(
          "turn/start",
          expect.objectContaining({
            responsesapiClientMetadata: expect.objectContaining({
              [CODEX_INFERENCE_GENERATION_KEY]: expect.any(String),
            }),
          }),
          expect.anything(),
        );
        attempt.resources.state.releaseInferenceContext?.();
      }
    } finally {
      controller.abort();
      roots.forEach((root) => root.release());
      context.close();
      await Promise.allSettled([pending]);
    }
  },
);

it("rejects lost relay ownership at protected continuation dispatch", async () => {
  const context = createCodexInferenceContext(() => {});
  inference.route = { context };
  const protectedWork = vi
    .spyOn(clientRuntime, "isCodexAppServerLiveThreadProtected")
    .mockReturnValue(true);
  const native = createNativeThread();
  try {
    const attempt = await prepare(undefined, native, false, (resources) => {
      const runtime = resources.prompt.context.runtime;
      runtime.runtimeParams.extraSystemPrompt = "Current internal continuation.";
      runtime.runtimeParams.extraSystemPromptTurnContext = {
        start: 0,
        text: "Current internal continuation.",
      };
      runtime.connection.assertLegacyCurrent = () => {};
      runtime.connection.params.hostCapabilities = {
        assertActive() {},
      } as typeof runtime.connection.params.hostCapabilities;
    });
    attempt.route.armTurn.mockImplementationOnce(() => {
      inference.route = undefined;
    });
    await expect(attempt.prepared.startCodexTurn()).rejects.toThrow(
      "requires a current parent-local inference relay",
    );
    expect(native.latest.status).toBe("failed");
    expect(attempt.nativeProcessAuthority.bindTurn).not.toHaveBeenCalled();
    expect(attempt.route.cancelTurn).toHaveBeenCalledOnce();
    expect(cleanup.interrupt).not.toHaveBeenCalled();
    expect(cleanup.retire).not.toHaveBeenCalled();
  } finally {
    protectedWork.mockRestore();
    context.close();
  }
});
