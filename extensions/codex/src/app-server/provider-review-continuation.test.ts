import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type {
  CodexServerNotification,
  CodexThreadTurnsListResponse,
  CodexTurnStartParams,
} from "./protocol.js";
import { prepareCodexProviderReviewContinuation } from "./provider-review-continuation.js";

type ProviderReviewAcknowledgment = NonNullable<
  AgentHarnessAttemptParamsV2["providerReviewAcknowledgment"]
>;
type ReviewSnapshot = ReturnType<ProviderReviewAcknowledgment["read"]>;
const sessionId = "session-1";
const findings = {
  explanation: "Review the intended operation.",
  continuation: { message: "  Use the approved target only.\n" },
};
const latest = (): CodexThreadTurnsListResponse => ({
  data: [
    {
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
  ],
});

function fixture() {
  let current = true;
  let phase: ReviewSnapshot["phase"] = "pending";
  const assertCurrent = () => {
    if (!current) {
      throw new Error("revoked");
    }
  };
  // The host's session tests own real issuance and durable comparison.
  const host = {
    read: vi.fn<ProviderReviewAcknowledgment["read"]>(),
    assertRuntime: vi.fn<ProviderReviewAcknowledgment["assertRuntime"]>(),
    acceptNativeTurn: vi.fn<ProviderReviewAcknowledgment["acceptNativeTurn"]>(),
  };
  const methods: Pick<ProviderReviewAcknowledgment, "read" | "assertRuntime" | "acceptNativeTurn"> =
    host;
  const acknowledgment = Object.freeze(methods) as ProviderReviewAcknowledgment;
  const snapshot: ReviewSnapshot = {
    phase,
    review: {
      id: "review-1",
      sessionId,
      runId: "failed-run",
      provider: "openai",
      model: "test-model",
      runtimeId: "codex",
      api: "openai-chatgpt-responses",
      nativeThreadId: "native-thread",
      nativeTurnId: "failed-turn",
      review: findings,
    },
  };
  host.read.mockImplementation(() => {
    assertCurrent();
    return { ...snapshot, phase };
  });
  host.assertRuntime.mockImplementation((params) => {
    params.assertCurrent();
    return Promise.resolve();
  });
  host.acceptNativeTurn.mockImplementation((accepted) => {
    accepted.assertCurrent?.();
    phase = "accepted";
    return Promise.resolve();
  });
  const request = vi.fn().mockResolvedValue(latest());
  let notificationHandler: ((notification: CodexServerNotification) => unknown) | undefined;
  const dispose = vi.fn(() => {
    notificationHandler = undefined;
  });
  const addNotificationHandler = vi.fn(
    (handler: (notification: CodexServerNotification) => unknown) => {
      notificationHandler = handler;
      return dispose;
    },
  );
  const turnStartParams: CodexTurnStartParams = {
    threadId: "native-thread",
    input: [
      { type: "text", text: "generated wrapper", text_elements: [] },
      { type: "skill", name: "selected", path: "/selected" },
    ],
    responsesapiClientMetadata: { openclaw_generation: "generation-1" },
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    approvalPolicy: "on-request",
    additionalContext: {
      trusted: { kind: "application", value: "existing developer instructions" },
    },
  };
  return {
    acknowledgment,
    host,
    phase: () => phase,
    request,
    turnStartParams,
    notify: (notification: CodexServerNotification) => notificationHandler?.(notification),
    dispose,
    revoke: () => {
      current = false;
    },
    prepare: () =>
      prepareCodexProviderReviewContinuation({
        acknowledgment,
        client: { request, addNotificationHandler },
        turnStartParams,
        provider: "openai",
        model: "test-model",
        api: "openai-chatgpt-responses",
        signal: new AbortController().signal,
        timeoutMs: 1000,
        assertCurrent,
      }),
  };
}

describe("native provider review continuation", () => {
  it("bounds the native read, preserves literal steer, and delegates only dispatched acceptance", async () => {
    const f = fixture();
    const continuation = await f.prepare();
    expect(f.request.mock.calls[0]?.slice(0, 2)).toEqual([
      "thread/turns/list",
      { threadId: "native-thread", limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
    ]);
    expect(f.turnStartParams.input).toEqual([
      { type: "text", text: findings.continuation.message, text_elements: [] },
    ]);
    expect(f.turnStartParams.responsesapiClientMetadata?.openclaw_generation).toBe("generation-1");
    expect(
      JSON.parse(f.turnStartParams.responsesapiClientMetadata!.misalignment_override!),
    ).toEqual({ timestamp: expect.any(Number) });
    expect(f.turnStartParams).toMatchObject({
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      approvalPolicy: "on-request",
      additionalContext: {
        trusted: { kind: "application", value: "existing developer instructions" },
      },
    });
    await expect(continuation?.accept("new-turn")).rejects.toThrow("has not dispatched");
    expect(f.host.acceptNativeTurn).not.toHaveBeenCalled();
    expect(f.host.assertRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "test-model",
        runtimeId: "codex",
        api: "openai-chatgpt-responses",
      }),
    );
    continuation?.dispatch();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(() => continuation?.dispatch()).toThrow("already dispatched");
    f.host.acceptNativeTurn.mockRejectedValueOnce(new Error("acceptance does not match"));
    await expect(continuation?.accept("failed-turn")).rejects.toThrow("does not match");
    expect(f.phase()).toBe("pending");
    await continuation?.accept("new-turn");
    expect(f.host.acceptNativeTurn).toHaveBeenLastCalledWith({
      nativeThreadId: "native-thread",
      nativeTurnId: "new-turn",
      assertCurrent: expect.any(Function),
    });
    expect(f.phase()).toBe("accepted");
    await expect(f.prepare()).rejects.toThrow("cannot start another native turn");
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("accepts matching durable turn identity when Codex omits memory-only findings", async () => {
    const f = fixture();
    const page = latest();
    page.data[0]!.error!.misalignment = null;
    f.request.mockResolvedValue(page);
    const continuation = await f.prepare();
    expect(f.turnStartParams.input).toEqual([
      { type: "text", text: findings.continuation.message, text_elements: [] },
    ]);
    continuation?.dispose();
    expect(f.phase()).toBe("pending");
  });

  it.each(["newer-turn", "active", "changed-findings"])(
    "rejects %s native state before dispatch",
    async (kind) => {
      const f = fixture();
      const page = latest();
      if (kind === "newer-turn") {
        page.data[0]!.id = "another-turn";
      }
      if (kind === "active") {
        page.data[0]!.status = "inProgress";
      }
      if (kind === "changed-findings") {
        page.data[0]!.error!.misalignment!.steer = { message: "Different steer" };
      }
      f.request.mockResolvedValue(page);
      await expect(f.prepare()).rejects.toThrow("native provider review changed");
      expect(f.phase()).toBe("pending");
    },
  );

  it("rejects a newer native turn notification after the latest-turn read", async () => {
    const f = fixture();
    const continuation = await f.prepare();
    f.notify({
      method: "turn/started",
      params: { threadId: "native-thread", turn: { id: "newer-turn" } },
    });
    expect(() => continuation?.dispatch()).toThrow("native provider review changed");
    expect(f.phase()).toBe("pending");
    continuation?.dispose();
  });

  it("revalidates capability after native state arrives and again at dispatch", async () => {
    const f = fixture();
    const response = createDeferred<CodexThreadTurnsListResponse>();
    const entered = createDeferred<void>();
    f.request.mockImplementation(() => {
      entered.resolve();
      return response.promise;
    });
    const pending = f.prepare();
    await entered.promise;
    f.revoke();
    response.resolve(latest());
    await expect(pending).rejects.toThrow("revoked");
    expect(f.phase()).toBe("pending");
    const next = fixture();
    const continuation = await next.prepare();
    next.revoke();
    expect(() => continuation?.dispatch()).toThrow("revoked");
    continuation?.dispose();
  });
});
