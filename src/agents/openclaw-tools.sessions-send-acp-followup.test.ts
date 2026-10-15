// Real tool routing, metadata and retained completion; external delivery is fixed I/O.
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markAcpTurnActive } from "../acp/control-plane/active-turns.js";
import { resetAcpActiveTurnsForTests } from "../acp/control-plane/active-turns.test-support.js";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createSessionVisibilityChecker } from "../plugin-sdk/session-visibility.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { observeSessionSendContinuations } from "./openclaw-tools.sessions-timeout.test-support.js";
import {
  readFollowupRequest,
  SessionFollowupCompletion,
} from "./subagents/completion/session-followup-completion.js";
import { prepareSessionsSendFollowup } from "./tools/sessions-send-followup-custody.js";
import { runSessionsSendA2AFlow } from "./tools/sessions-send-tool.a2a.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

const { config, callGatewayMock } = vi.hoisted(() => ({
  config: {
    agents: { entries: { main: {}, claude: {} } },
    session: { mainKey: "main", scope: "per-sender" },
    tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
    acp: { enabled: true, allowedAgents: ["claude"] },
  } as OpenClawConfig,
  callGatewayMock: vi.fn(),
}));
vi.mock("../gateway/call.js", () => ({ callGateway: (opts: unknown) => callGatewayMock(opts) }));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => config,
  resolveGatewayPort: () => 18789,
}));
// Preparation/revocation are independently covered by sessions-send-followup.test.ts.
vi.mock("./tools/sessions-send-followup-custody.js", () => ({
  prepareSessionsSendFollowup: vi.fn(),
}));
vi.mock("./tools/sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: vi.fn(async () => {}),
}));
import "./test-helpers/fast-openclaw-tools-sessions.js";

const requesterKey = "agent:main:cron:acp-followup:run:parent-run";
const targetKey = "agent:claude:acp:resumable-child";
let state: OpenClawTestState;
let continuations: ReturnType<typeof observeSessionSendContinuations>;
const owners: SessionFollowupCompletion[] = [];
const releaseCustody = vi.fn();

beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  config.session = {
    mainKey: "main",
    scope: "per-sender",
    store: state.path("agents", "{agentId}", "sessions", "sessions.json"),
  };
  setRuntimeConfigSnapshot(config);
  resetGatewayWorkAdmission();
  resetAcpActiveTurnsForTests();
  continuations = observeSessionSendContinuations();
  vi.mocked(runSessionsSendA2AFlow).mockClear();
  releaseCustody.mockClear();
  vi.mocked(prepareSessionsSendFollowup).mockImplementation(async (input) => ({
    ...input,
    requesterSessionId: "parent-incarnation",
    custody: {
      signal: new AbortController().signal,
      assertCurrent() {},
      release: releaseCustody,
      run: (work) => work(),
    },
  }));
  callGatewayMock
    .mockReset()
    .mockImplementation(async (call: { method: string; params?: Record<string, unknown> }) => {
      if (call.method === "agent") {
        const runId = String(call.params?.idempotencyKey);
        const request = readFollowupRequest(runId, String(call.params?.sessionKey));
        if (request) {
          const owner = SessionFollowupCompletion.bind(request);
          request.completion = owner;
          owner.markAccepted(runId);
          owners.push(owner);
        }
        return { status: "accepted", runId };
      }
      if (call.method === "agent.wait") {
        return {
          status: "ok",
          terminalReply: { disposition: "visible", text: "Caller-owned result" },
        };
      }
      return {};
    });
});
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    if (!owner.signal.aborted) {
      await owner.settle(owner.request.runId, {
        status: "ok",
        terminalReply: { disposition: "visible", text: "Cleanup result" },
      });
      owner.finishExecution(owner.request.runId);
    }
  }
  await continuations.settle();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  continuations.restore();
  resetGatewayWorkAdmission();
  resetAcpActiveTurnsForTests();
  await state.cleanup();
});

async function prepareChild(
  params: {
    metadata?: boolean;
    supported?: boolean;
    ready?: boolean;
    stableIdentity?: boolean;
  } = {},
) {
  for (const [agentId, sessionKey, entry] of [
    ["main", requesterKey, { sessionId: "parent-incarnation", updatedAt: 1 }],
    [
      "claude",
      targetKey,
      {
        sessionId: "child-incarnation",
        updatedAt: 1,
        spawnedBy: requesterKey,
        parentSessionKey: requesterKey,
        status: "done" as const,
        endedAt: 2,
      },
    ],
  ] as const) {
    await replaceSessionEntry(
      {
        agentId,
        sessionKey,
        storePath: resolveSessionStorePathCore(config.session?.store, { agentId }),
      },
      entry,
    );
  }
  if (params.metadata !== false) {
    await upsertAcpSessionMeta({
      cfg: config,
      sessionKey: targetKey,
      agentId: "claude",
      mutate: () => ({
        backend: "acpx",
        agent: "claude",
        runtimeSessionName: "original-runtime",
        mode: "oneshot",
        state: "running",
        cwd: "/workspace/project",
        lastActivityAt: 1,
        identity: {
          state: "resolved",
          source: "status",
          ...(params.stableIdentity === false
            ? {}
            : { acpxSessionId: "original-protocol-session" }),
          sessionResumeSupported: params.supported ?? true,
          sessionResumeReady: params.ready ?? true,
          lastUpdatedAt: 1,
        },
      }),
    });
  }
}

function send(extra: Record<string, unknown> = {}, callerOwnsCompletion = false) {
  const tool = createSessionsSendTool({
    config,
    agentSessionKey: requesterKey,
    callGateway: callGatewayMock,
    ...(callerOwnsCompletion ? { completionOwner: "caller" as const } : {}),
  });
  return {
    tool,
    result: tool.execute("acp-followup", {
      sessionKey: targetKey,
      message: "Continue the previous work",
      timeoutSeconds: 1,
      ...extra,
    }),
  };
}

describe("parent-owned ACP one-shot follow-ups", () => {
  it.each([undefined, "followup"] as const)(
    "retains one asynchronous completion for mode %s",
    async (mode) => {
      await prepareChild();
      const { tool, result } = send(mode ? { mode } : {});
      const sent = await result;
      expect(sent.details).toMatchObject({
        status: "accepted",
        sessionKey: targetKey,
        targetDisposition: "queued",
        delivery: { status: "pending" },
      });
      expect(Value.Check(tool.outputSchema!, sent.details)).toBe(true);
      expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
      expect(owners).toHaveLength(1);
      const owner = owners[0]!;
      expect(owner.request).toMatchObject({
        requesterSessionKey: requesterKey,
        requesterSessionId: "parent-incarnation",
        targetSessionKey: targetKey,
      });
      await owner.settle(owner.request.runId, {
        status: "ok",
        terminalReply: { disposition: "visible", text: "Continued result" },
      });
      // Terminal production does not release the result before execution cleanup.
      expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
      owner.finishExecution(owner.request.runId);
      await continuations.settle();
      expect(runSessionsSendA2AFlow).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          runId: owner.request.runId,
          targetSessionKey: targetKey,
          requesterSessionKey: requesterKey,
          replyMode: "one-way",
          notifyRequesterOnWaitFailure: true,
          reply: expect.objectContaining({
            terminalReply: { disposition: "visible", text: "Continued result" },
          }),
          deliverRequesterReply: expect.any(Function),
        }),
      );
      expect(releaseCustody).toHaveBeenCalledOnce();
      expect(callGatewayMock.mock.calls.filter(([call]) => call.method === "agent")).toHaveLength(
        1,
      );
      expect(
        callGatewayMock.mock.calls.some(([call]) =>
          ["agent.wait", "chat.history", "send"].includes(call.method),
        ),
      ).toBe(false);
    },
  );

  it("retains failure notification for an isolated cron parent", async () => {
    await prepareChild();
    expect((await send().result).details).toMatchObject({ status: "accepted" });
    const owner = owners[0]!;
    await owner.settle(owner.request.runId, { status: "error", error: "Resume failed" });
    owner.finishExecution(owner.request.runId);
    await continuations.settle();
    expect(runSessionsSendA2AFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        notifyRequesterOnWaitFailure: true,
        replyMode: "one-way",
        reply: { status: "error", error: "Resume failed" },
      }),
    );
  });

  it.each([
    { supported: false, error: "does not support session resume" },
    { ready: false, error: "not ready to resume" },
    { stableIdentity: false, error: "stable ACP session id" },
    { metadata: false, error: "resume metadata is no longer available" },
  ])("rejects unsafe follow-up: $error", async ({ error, ...params }) => {
    await prepareChild(params);
    expect((await send().result).details).toMatchObject({
      status: "error",
      error: expect.stringContaining(error),
    });
    expect(callGatewayMock.mock.calls.some(([call]) => call.method === "agent")).toBe(false);
  });

  it.each(["claude", "other-owner"])("checks live turns under exact owner %s", async (agentId) => {
    await prepareChild();
    const release = markAcpTurnActive({ sessionKey: targetKey, agentId });
    try {
      expect((await send().result).details).toMatchObject({
        status: agentId === "claude" ? "error" : "accepted",
      });
    } finally {
      release?.();
    }
  });

  it.each(["caller", "scoped-grant"] as const)(
    "preserves inline completion for %s",
    async (owner) => {
      await prepareChild();
      const unregister =
        owner === "scoped-grant"
          ? createSessionVisibilityChecker.registerScopedAccessProvider((request) =>
              request.requesterSessionKey === requesterKey && request.targetSessionKey === targetKey
                ? { expectedSessionId: "child-incarnation" }
                : undefined,
            )
          : () => {};
      try {
        expect((await send({}, owner === "caller").result).details).toMatchObject({
          status: "ok",
          reply: "Caller-owned result",
          delivery: { status: "skipped" },
        });
        expect(owners).toHaveLength(0);
        expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
        expect(
          callGatewayMock.mock.calls.filter(([call]) => call.method === "agent.wait"),
        ).toHaveLength(1);
      } finally {
        unregister();
      }
    },
  );

  it("leaves notify as a notification without starting a turn", async () => {
    await prepareChild({ ready: false });
    expect((await send({ mode: "notify", timeoutSeconds: 0 }).result).details).toMatchObject({
      status: "queued",
      runStarted: false,
    });
    expect(callGatewayMock.mock.calls.some(([call]) => call.method === "agent")).toBe(false);
  });
});
