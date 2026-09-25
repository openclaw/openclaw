// Verifies parent-owned ACP follow-ups at the sessions_send tool boundary.
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const { callGatewayMock, readAcpSessionMetaForEntryMock, TEST_CONFIG } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  readAcpSessionMetaForEntryMock: vi.fn(),
  TEST_CONFIG: {
    session: { mainKey: "main", scope: "per-sender" },
    tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
  } as OpenClawConfig,
}));
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));
vi.mock("../commands/agent.js", () => ({
  agentCommandFromIngress: vi.fn(async () => ({
    payloads: [{ text: "ANNOUNCE_SKIP", mediaUrl: null }],
    meta: { durationMs: 1 },
  })),
}));
vi.mock("../acp/runtime/session-meta-readonly.js", () => ({
  readAcpSessionMetaForEntry: (params: unknown) => readAcpSessionMetaForEntryMock(params),
}));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => TEST_CONFIG,
  resolveGatewayPort: () => 18789,
}));

import "./test-helpers/fast-openclaw-tools-sessions.js";
import { markAcpTurnActive } from "../acp/control-plane/active-turns.js";
import { resetAcpActiveTurnsForTests } from "../acp/control-plane/active-turns.test-support.js";
import { observeSessionSendContinuations } from "./openclaw-tools.sessions-timeout.test-support.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type GatewayCall = { method?: string; params?: Record<string, unknown> };
let state: OpenClawTestState;
let continuations: ReturnType<typeof observeSessionSendContinuations>;

beforeEach(async () => {
  continuations = observeSessionSendContinuations();
  state = await createOpenClawTestState({ scenario: "minimal" });
  resetGatewayWorkAdmission();
  resetAcpActiveTurnsForTests();
  callGatewayMock.mockReset();
  readAcpSessionMetaForEntryMock.mockReset();
});
afterEach(async () => {
  await continuations.settle();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  continuations.restore();
  resetGatewayWorkAdmission();
  resetAcpActiveTurnsForTests();
  resetSystemEventsForTest();
  await state.cleanup();
});

describe("parent-owned ACP one-shot follow-ups", () => {
  const requesterKey = "agent:main:cron:acp-followup";
  const targetKey = "agent:claude:acp:resumable-child";

  async function prepareChild(
    params: {
      metadata?: boolean;
      supported?: boolean;
      ready?: boolean;
      stableIdentity?: boolean;
      targetSessionKey?: string;
      allowedAgents?: string[];
    } = {},
  ) {
    const sessionKey = params.targetSessionKey ?? targetKey;
    const agentId = parseAgentSessionKey(sessionKey)?.agentId;
    if (!agentId) {
      throw new Error(`Expected an agent-scoped fixture key: ${sessionKey}`);
    }
    const storePath = path.join(tempDirs.make("openclaw-acp-followup-"), "sessions.json");
    const config: OpenClawConfig = {
      ...TEST_CONFIG,
      session: { ...TEST_CONFIG.session, store: storePath },
      acp: { enabled: true, allowedAgents: params.allowedAgents ?? ["claude"] },
    };
    const entry = {
      sessionId: "acp-child-incarnation",
      updatedAt: 1,
      spawnedBy: requesterKey,
      parentSessionKey: requesterKey,
      status: "done" as const,
      endedAt: 2,
    };
    await upsertSessionEntryCore({ agentId, sessionKey, storePath }, entry);
    readAcpSessionMetaForEntryMock.mockImplementation(
      (lookup: { sessionKey: string; agentId?: string; entry?: { sessionId: string } }) =>
        lookup.sessionKey === sessionKey &&
        lookup.agentId === agentId &&
        lookup.entry?.sessionId === entry.sessionId
          ? metadata
          : undefined,
    );
    const metadata =
      params.metadata === false
        ? undefined
        : {
            backend: "acpx",
            agent: "claude",
            runtimeSessionName: "original-runtime",
            mode: "oneshot",
            // A persisted running flag is not live process authority.
            state: "running",
            cwd: "/workspace/project",
            lastActivityAt: 1,
            identity: {
              state: "resolved",
              source: "status",
              agentSessionId:
                params.stableIdentity === false ? undefined : "original-harness-session",
              sessionResumeSupported: params.supported ?? true,
              sessionResumeReady: params.ready ?? true,
              lastUpdatedAt: 1,
            },
          };
    callGatewayMock.mockImplementation(async (call: GatewayCall) => {
      if (call.method === "agent") {
        return { status: "accepted", runId: "acp-followup-run" };
      }
      return {};
    });
    return { config, entry, sessionKey, agentId };
  }

  it.each([undefined, "followup"] as const)(
    "keeps the same session and task completion owner for mode %s",
    async (mode) => {
      const { config, entry } = await prepareChild();
      const tool = createSessionsSendTool({
        config,
        agentSessionKey: requesterKey,
        callGateway: callGatewayMock,
      });
      const result = await tool.execute("acp-followup", {
        sessionKey: targetKey,
        message: "Yes, continue with the previous context.",
        timeoutSeconds: 1,
        ...(mode ? { mode } : {}),
      });
      expect(result.details).toMatchObject({
        status: "accepted",
        runId: "acp-followup-run",
        sessionKey: targetKey,
        targetDisposition: "queued",
        delivery: { status: "skipped", mode: "announce" },
      });
      expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
      expect(readAcpSessionMetaForEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "claude",
          sessionKey: targetKey,
          entry: expect.objectContaining({
            sessionId: entry.sessionId,
            spawnedBy: requesterKey,
            parentSessionKey: requesterKey,
          }),
        }),
      );
      const sends = callGatewayMock.mock.calls.filter(([call]) => call.method === "agent");
      expect(sends).toHaveLength(1);
      expect(sends[0]?.[0].params).toMatchObject({
        agentId: "claude",
        sessionKey: targetKey,
        deliver: false,
      });
      expect(
        callGatewayMock.mock.calls.some(([call]) =>
          ["agent.wait", "chat.history", "send"].includes(call.method),
        ),
      ).toBe(false);
    },
  );

  it.each([
    { supported: false, error: "does not support session resume" },
    { ready: false, error: "not ready to resume" },
    { stableIdentity: false, error: "stable ACP session id" },
    { metadata: false, error: "resume metadata is no longer available" },
  ])("rejects unsafe follow-up: $error", async ({ error, ...params }) => {
    const { config } = await prepareChild(params);
    const tool = createSessionsSendTool({
      config,
      agentSessionKey: requesterKey,
      callGateway: callGatewayMock,
    });
    const result = await tool.execute("acp-followup", {
      sessionKey: targetKey,
      message: "Continue",
      timeoutSeconds: 0,
    });
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining(error),
    });
    expect(callGatewayMock.mock.calls.some(([call]) => call.method === "agent")).toBe(false);
  });

  it.each(["claude", "other-owner"])(
    "checks active turns under the exact owner %s",
    async (activeOwner) => {
      const { config } = await prepareChild();
      const release = markAcpTurnActive({ sessionKey: targetKey, agentId: activeOwner });
      try {
        const tool = createSessionsSendTool({
          config,
          agentSessionKey: requesterKey,
          callGateway: callGatewayMock,
        });
        const result = await tool.execute("acp-followup", {
          sessionKey: targetKey,
          message: "Continue",
          timeoutSeconds: 0,
        });
        expect(result.details).toMatchObject({
          status: activeOwner === "claude" ? "error" : "accepted",
        });
        expect(callGatewayMock.mock.calls.filter(([call]) => call.method === "agent")).toHaveLength(
          activeOwner === "claude" ? 0 : 1,
        );
      } finally {
        release?.();
      }
    },
  );

  it("leaves notify as a notification without starting a one-shot turn", async () => {
    const { config } = await prepareChild({ ready: false });
    const tool = createSessionsSendTool({
      config,
      agentSessionKey: requesterKey,
      callGateway: callGatewayMock,
    });
    const result = await tool.execute("notify-acp", {
      sessionKey: targetKey,
      message: "A new fact for the next turn",
      mode: "notify",
    });
    expect(result.details).toMatchObject({ status: "queued", runStarted: false });
    expect(callGatewayMock.mock.calls.some(([call]) => call.method === "agent")).toBe(false);
  });

  it("recognizes legacy metadata loss for wildcard-allowed harnesses", async () => {
    const { config, sessionKey } = await prepareChild({
      metadata: false,
      targetSessionKey: "agent:custom-harness:acp:legacy-child",
      allowedAgents: ["*"],
    });
    const tool = createSessionsSendTool({
      config,
      agentSessionKey: requesterKey,
      callGateway: callGatewayMock,
    });
    const result = await tool.execute("legacy-acp", {
      sessionKey,
      message: "Continue",
      timeoutSeconds: 0,
    });
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("resume metadata is no longer available"),
    });
    expect(callGatewayMock.mock.calls.some(([call]) => call.method === "agent")).toBe(false);
  });

  it.each([
    { label: "changed", allowedAgents: ["codex"] },
    { label: "empty", allowedAgents: [] },
  ])("rejects legacy ACP follow-ups when the allowlist is $label", async ({ allowedAgents }) => {
    const { config, sessionKey } = await prepareChild({
      metadata: false,
      targetSessionKey: "agent:removed:acp:legacy-child",
      allowedAgents,
    });
    const tool = createSessionsSendTool({
      config,
      agentSessionKey: requesterKey,
      callGateway: callGatewayMock,
    });
    const result = await tool.execute("legacy-acp-after-config-change", {
      sessionKey,
      message: "Continue in the previous context",
      timeoutSeconds: 0,
    });
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("resume metadata is no longer available"),
    });
    expect(callGatewayMock.mock.calls.some(([call]) => call.method === "agent")).toBe(false);
  });

  it("leaves configured ACP bindings outside the legacy one-shot guard", async () => {
    const { config, sessionKey } = await prepareChild({
      metadata: false,
      targetSessionKey: "agent:claude:acp:binding:configured",
      allowedAgents: [],
    });
    const tool = createSessionsSendTool({
      config,
      agentSessionKey: requesterKey,
      callGateway: callGatewayMock,
    });
    const result = await tool.execute("configured-acp-binding", {
      sessionKey,
      message: "Continue",
      timeoutSeconds: 0,
    });
    expect(result.details).toMatchObject({ status: "accepted" });
    expect(callGatewayMock.mock.calls.filter(([call]) => call.method === "agent")).toHaveLength(1);
  });

  it("preserves deleted-agent errors for ordinary non-ACP sessions", async () => {
    const { config, sessionKey } = await prepareChild({
      metadata: false,
      targetSessionKey: "agent:deleted-agent:worker",
    });
    callGatewayMock.mockImplementation(async (call: GatewayCall) => {
      if (call.method === "agent") {
        throw new Error('Agent "deleted-agent" no longer exists in configuration');
      }
      return {};
    });
    const tool = createSessionsSendTool({
      config,
      agentSessionKey: requesterKey,
      callGateway: callGatewayMock,
    });
    const result = await tool.execute("deleted-agent", {
      sessionKey,
      message: "Continue",
      timeoutSeconds: 0,
    });
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining('Agent "deleted-agent" no longer exists'),
    });
    expect(callGatewayMock.mock.calls.filter(([call]) => call.method === "agent")).toHaveLength(1);
  });
});
