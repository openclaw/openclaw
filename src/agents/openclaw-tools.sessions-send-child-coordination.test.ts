import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listSessionParticipantsReadOnly,
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveGatewaySessionStoreTargetWithStore } from "../gateway/session-utils-store-lookup.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

const { config, callGatewayMock, readAcpSessionMetaMock, readAcpSessionMetaForEntryMock } =
  vi.hoisted(() => ({
    config: {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [{ id: "main", default: true }, { id: "peer" }],
      },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
    } as OpenClawConfig,
    callGatewayMock: vi.fn(),
    readAcpSessionMetaMock: vi.fn(),
    readAcpSessionMetaForEntryMock: vi.fn(),
  }));
vi.mock("../acp/runtime/session-meta.js", () => ({
  readAcpSessionMeta: (params: unknown) => readAcpSessionMetaMock(params),
  readAcpSessionEntryAsync: async (params: {
    cfg?: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
    assertCurrent?: () => void;
  }) => {
    params.assertCurrent?.();
    const cfg = params.cfg ?? config;
    const target = resolveGatewaySessionStoreTargetWithStore({
      cfg,
      key: params.sessionKey,
      agentId: params.agentId,
      readOnly: true,
      exactRead: true,
    });
    const entry = target.store[target.canonicalKey];
    const acp = await readAcpSessionMetaForEntryMock({
      ...params,
      cfg,
      sessionKey: target.canonicalKey,
      agentId: target.agentId,
      entry,
    });
    params.assertCurrent?.();
    return {
      cfg,
      agentId: target.agentId,
      storePath: target.storePath,
      sessionKey: params.sessionKey,
      storeSessionKey: target.canonicalKey,
      entry,
      acp,
    };
  },
}));
vi.mock("../acp/runtime/session-meta-readonly.js", async () => {
  const { rowToAcpSessionMeta } = await vi.importActual<
    typeof import("../acp/runtime/session-meta-readonly.js")
  >("../acp/runtime/session-meta-readonly.js");
  return {
    rowToAcpSessionMeta,
    readAcpSessionMetaForEntry: (params: unknown) => readAcpSessionMetaForEntryMock(params),
  };
});
vi.mock("../gateway/call.js", () => ({ callGateway: (opts: unknown) => callGatewayMock(opts) }));
vi.mock("../commands/agent.js", () => ({ agentCommandFromIngress: vi.fn() }));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => config,
  resolveGatewayPort: () => 18789,
}));

import "./test-helpers/fast-openclaw-tools-sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { observeSessionSendContinuations } from "./openclaw-tools.sessions-timeout.test-support.js";
import { testing as agentStepTesting } from "./tools/agent-step.test-support.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const continuations = observeSessionSendContinuations({ trackAllWork: true });

async function settleSessionWork() {
  await continuations.settle();
  await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
}

afterAll(() => {
  continuations.restore();
});

type GatewayCall = { method?: string; params?: Record<string, unknown> };
type AgentCallParams = {
  extraSystemPrompt?: string;
  inputProvenance?: { sourceSessionKey?: string; sourceRole?: string };
};
const calls: GatewayCall[] = [];
const finalAnnounce = vi.fn(async () => ({
  payloads: [{ text: "ANNOUNCE_SKIP", mediaUrl: null }],
  meta: { durationMs: 1 },
}));
function mockGatewayReply(
  waitResult: Record<string, unknown> = {
    status: "ok",
    terminalReply: { disposition: "visible", text: "Requested result" },
  },
) {
  callGatewayMock.mockImplementation(async (request: GatewayCall) => {
    calls.push(request);
    if (request.method === "agent") {
      return { runId: "coordination-run", status: "accepted" };
    }
    return request.method === "agent.wait" ? waitResult : {};
  });
}
function agentParams(call: GatewayCall): AgentCallParams {
  return (call.params ?? {}) as AgentCallParams;
}
function send(requesterKey: string, targetKey: string, timeoutSeconds = 1) {
  return createSessionsSendTool({
    agentSessionKey: requesterKey,
    config,
    callGateway: callGatewayMock,
  }).execute("coordination", {
    sessionKey: targetKey,
    message: "Return the requested result",
    timeoutSeconds,
  });
}
function expectCoordination(
  result: Awaited<ReturnType<typeof send>>,
  child: boolean,
  requesterChild: boolean,
) {
  expect.soft(result.details).toMatchObject({
    status: "ok",
    reply: "Requested result",
    delivery: { status: child ? "skipped" : "pending" },
  });
  const agentCalls = calls.filter((call) => call.method === "agent");
  expect.soft(agentCalls).toHaveLength(child ? 1 : 6);
  expect
    .soft(agentParams(agentCalls[0] ?? {}).inputProvenance?.sourceRole)
    .toBe(requesterChild ? "subagent" : undefined);
  return agentCalls;
}
async function writeEntry(sessionKey: string, entry: SessionEntry, storePath?: string) {
  const agentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (!agentId) {
    throw new Error(`Expected an agent-scoped fixture key: ${sessionKey}`);
  }
  await replaceSessionEntry(
    {
      agentId,
      sessionKey,
      storePath: storePath ?? resolveSessionStorePathCore(config.session?.store, { agentId }),
    },
    entry,
  );
}

describe("sessions_send child coordination", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
    config.session = {
      mainKey: "main",
      scope: "per-sender",
      dmScope: "main",
      store: state.path("configured", "agents", "{agentId}", "sessions", "sessions.json"),
    };
    resetGatewayWorkAdmission();
    callGatewayMock.mockReset();
    calls.length = 0;
    mockGatewayReply();
    finalAnnounce.mockClear();
    readAcpSessionMetaMock.mockReset().mockReturnValue(undefined);
    readAcpSessionMetaForEntryMock
      .mockReset()
      .mockImplementation((params: unknown) => readAcpSessionMetaMock(params));
    setActivePluginRegistry(createSessionConversationTestRegistry());
    await agentStepTesting.setDepsForTest({ agentCommandFromIngress: finalAnnounce });
  });
  afterEach(async () => {
    await settleSessionWork();
    resetGatewayWorkAdmission();
    await agentStepTesting.setDepsForTest();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  });

  it.each([
    { direction: "requester", child: true },
    { direction: "target", child: false },
  ])(
    "uses the registered alternate store for $direction with child=$child",
    async ({ direction, child }) => {
      const peerKey = "agent:peer:main";
      const alternateKey = child ? "agent:main:dashboard:alternate" : "agent:main:subagent:root";
      const alternate = openOpenClawAgentDatabase({ agentId: "main" });
      const configuredStorePath = resolveSessionStorePathCore(config.session?.store, {
        agentId: "main",
      });
      const alternateScope = {
        agentId: "main",
        sessionKey: alternateKey,
        storePath: alternate.path,
      };
      await writeEntry(peerKey, { sessionId: "peer-session", updatedAt: 1 });
      await writeEntry(
        alternateKey,
        {
          sessionId: "alternate-session",
          updatedAt: 1,
          parentSessionKey: peerKey,
          ...(child ? { spawnedBy: peerKey, spawnDepth: 1 } : { spawnDepth: 0 }),
        },
        alternate.path,
      );
      expect(
        loadSessionEntryReadOnly({ ...alternateScope, storePath: configuredStorePath }),
      ).toBeUndefined();
      const requesterKey = direction === "requester" ? alternateKey : peerKey;
      const targetKey = direction === "target" ? alternateKey : peerKey;
      const result = await send(requesterKey, targetKey);
      await settleSessionWork();
      const agentCalls = expectCoordination(result, child, direction === "requester" && child);
      if (child) {
        expect(result.details).toMatchObject({ delivery: { mode: "announce" } });
        expect(agentParams(agentCalls[0] ?? {}).extraSystemPrompt).toBeUndefined();
        expect(finalAnnounce).not.toHaveBeenCalled();
        expect(calls.some((call) => call.method === "send")).toBe(false);
      }
      if (direction === "target") {
        await runOpenClawAgentWriteAdmission(
          toDatabaseOptions(resolveSqliteScope(alternateScope)),
          () => undefined,
        );
        expect
          .soft(listSessionParticipantsReadOnly(alternateScope).get(alternateKey) ?? [])
          .toEqual([
            expect.objectContaining({
              identity: { type: "agent", id: "peer" },
              contributionCount: 1,
            }),
          ]);
        expect
          .soft(
            listSessionParticipantsReadOnly({
              ...alternateScope,
              storePath: configuredStorePath,
            }).get(alternateKey) ?? [],
          )
          .toEqual([]);
      }
    },
  );

  it.each(["requester", "target"])(
    "binds %s ACP coordination to its loaded lifecycle entry",
    async (direction) => {
      const expectedChild = direction === "target";
      const lifecycleRevision = expectedChild ? "current" : "retired";
      const sessionId = "same-session";
      const sessionStartedAt = 50;
      const metadata = await vi.importActual<typeof import("../acp/runtime/session-meta.js")>(
        "../acp/runtime/session-meta.js",
      );
      const metadataRead = await vi.importActual<
        typeof import("../acp/runtime/session-meta-readonly.js")
      >("../acp/runtime/session-meta-readonly.js");
      const databasePath = path.join(
        tempDirs.make("sessions-send-acp-binding-"),
        "openclaw.sqlite",
      );
      const peerKey = "agent:main:main";
      const reusedKey = "agent:main:dashboard:reused-acp";
      const requesterKey = direction === "requester" ? reusedKey : peerKey;
      const targetKey = direction === "target" ? reusedKey : peerKey;
      const currentEntry: SessionEntry = {
        sessionId: "same-session",
        lifecycleRevision: "current",
        sessionStartedAt,
        updatedAt: 200,
        parentSessionKey: peerKey,
      };
      metadata.writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey: reusedKey,
        sessionId,
        lifecycleRevision,
        now: () => 100,
        meta: {
          backend: "acpx",
          agent: "main",
          runtimeSessionName: "previous-acp",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 100,
        },
      });
      // The separate lookup can observe another entry snapshot; classification must
      // join its metadata against the entry already selected by sessions_send.
      readAcpSessionMetaMock.mockImplementation(
        (params: Parameters<typeof metadata.readAcpSessionMeta>[0]) =>
          metadataRead.readAcpSessionMetaForEntry({
            ...params,
            databasePath,
            entry: { sessionId, lifecycleRevision, sessionStartedAt: 50 },
          }),
      );
      readAcpSessionMetaForEntryMock.mockImplementation(
        (params: Parameters<typeof metadataRead.readAcpSessionMetaForEntry>[0]) =>
          metadataRead.readAcpSessionMetaForEntry({ ...params, databasePath }),
      );
      await writeEntry(reusedKey, currentEntry);
      const result = await send(requesterKey, targetKey);
      await settleSessionWork();
      expectCoordination(result, expectedChild, direction === "requester" && expectedChild);
    },
  );

  it.each([
    {
      name: "hidden child with opaque direct token under main DM scope",
      requesterKey: "agent:main:subagent:direct:peer-1",
      targetKey: "agent:peer:main",
      entry: {},
      timeoutSeconds: 0,
    },
    {
      name: "restored child with cyclic lineage",
      requesterKey: "agent:main:dashboard:cycle",
      entry: { spawnedBy: "agent:main:dashboard:cycle" },
      timeoutSeconds: 1,
    },
  ])(
    "sessions_send does not start reply turns for $name after timeoutSeconds=$timeoutSeconds",
    async ({ requesterKey, entry, timeoutSeconds, targetKey = "agent:main:main" }) => {
      await writeEntry(requesterKey, { sessionId: "child", updatedAt: 1, ...entry });
      mockGatewayReply({ status: "timeout" });
      const result = await send(requesterKey, targetKey, timeoutSeconds);
      expect(result.details).toMatchObject({
        status: "accepted",
        delivery: { status: "skipped", mode: "announce" },
      });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      const agentCalls = calls.filter((call) => call.method === "agent");
      expect(agentCalls).toHaveLength(1);
      expect(agentCalls[0]?.params).toMatchObject({
        sessionKey: targetKey,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: requesterKey,
          sourceTool: "sessions_send",
        },
      });
      expect(agentParams(agentCalls[0] ?? {}).inputProvenance?.sourceRole).toBe("subagent");
      expect(calls.filter((call) => call.method === "agent.wait")).toHaveLength(
        timeoutSeconds === 0 ? 0 : 1,
      );
    },
  );
});
