import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
// Verifies one-way child coordination at the sessions_send tool boundary.
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listSessionParticipantsReadOnly,
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveGatewaySessionStoreTargetWithStore } from "../gateway/session-utils-store-lookup.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

const { config, callGatewayMock, readAcpSessionMetaMock, readAcpSessionMetaForEntryMock } =
  vi.hoisted(() => ({
    config: {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [{ id: "main", default: true }, { id: "peer" }, { id: "penny" }, { id: "director" }],
      },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
    } as OpenClawConfig,
    callGatewayMock: vi.fn(),
    readAcpSessionMetaMock: vi.fn(),
    readAcpSessionMetaForEntryMock: vi.fn(),
  }));
vi.mock("../acp/runtime/session-meta.js", () => ({
  readAcpSessionMeta: (params: unknown) => readAcpSessionMetaMock(params),
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
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { testing as agentStepTesting } from "./tools/agent-step.test-support.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type GatewayCall = { method?: string; params?: Record<string, unknown> };
type AgentCallParams = {
  extraSystemPrompt?: string;
  inputProvenance?: { sourceSessionKey?: string; sourceRole?: string };
};
function agentParams(call: GatewayCall): AgentCallParams {
  return (call.params ?? {}) as AgentCallParams;
}
function sessionsSendDetails(details: unknown) {
  return details as { reply?: string; delivery?: { status?: string } };
}
function createSendTool(agentSessionKey: string) {
  return createSessionsSendTool({ agentSessionKey, config, callGateway: callGatewayMock });
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
    readAcpSessionMetaMock.mockReset().mockReturnValue(undefined);
    readAcpSessionMetaForEntryMock
      .mockReset()
      .mockImplementation((params: unknown) => readAcpSessionMetaMock(params));
    setActivePluginRegistry(createSessionConversationTestRegistry());
    agentStepTesting.setDepsForTest({
      agentCommandFromIngress: async () => ({
        payloads: [{ text: "ANNOUNCE_SKIP", mediaUrl: null }],
        meta: { durationMs: 1 },
      }),
    });
  });
  afterEach(async () => {
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    resetGatewayWorkAdmission();
    agentStepTesting.setDepsForTest();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  });

  it.each([
    { direction: "requester", child: true },
    { direction: "target", child: true },
    { direction: "requester", child: false },
    { direction: "target", child: false },
  ])(
    "uses the registered alternate store for $direction with child=$child",
    async ({ direction, child }) => {
      const peerKey = "agent:peer:main";
      const alternateKey = "agent:main:dashboard:alternate";
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
          ...(child ? { spawnedBy: peerKey, spawnDepth: 1 } : {}),
        },
        alternate.path,
      );
      expect(
        loadSessionEntryReadOnly({ ...alternateScope, storePath: configuredStorePath }),
      ).toBeUndefined();
      const selected = resolveGatewaySessionStoreTargetWithStore({
        cfg: config,
        key: alternateKey,
        agentId: "main",
        readOnly: true,
        exactRead: true,
      });
      expect(selected.store[selected.canonicalKey]?.sessionId).toBe("alternate-session");
      expect(selected.readSource?.path).toBe(alternate.path);
      const requesterKey = direction === "requester" ? alternateKey : peerKey;
      const targetKey = direction === "target" ? alternateKey : peerKey;
      const calls: GatewayCall[] = [];
      callGatewayMock.mockImplementation(async (request: GatewayCall) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "alternate-run", status: "accepted" };
        }
        if (request.method === "agent.wait") {
          return {
            status: "ok",
            terminalReply: { disposition: "visible", text: "Requested result" },
          };
        }
        return {};
      });
      const result = await createSendTool(requesterKey).execute("alternate-coordination", {
        sessionKey: targetKey,
        message: "Return the requested result",
        timeoutSeconds: 1,
      });
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect.soft(result.details).toMatchObject({
        status: "ok",
        reply: "Requested result",
        delivery: { status: child ? "skipped" : "pending" },
      });
      const agentCalls = calls.filter((call) => call.method === "agent");
      expect
        .soft(agentParams(agentCalls[0] ?? {}).inputProvenance?.sourceRole)
        .toBe(direction === "requester" && child ? "subagent" : undefined);
      expect.soft(agentCalls).toHaveLength(child ? 1 : 6);
      if (direction === "target") {
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

  it.each(
    [
      {
        binding: "retired lifecycle",
        sessionId: "same-session",
        lifecycleRevision: "retired",
        sessionStartedAt: 50,
        expectedChild: false,
      },
      {
        binding: "retired session",
        sessionId: "retired-session",
        lifecycleRevision: undefined,
        sessionStartedAt: 50,
        expectedChild: false,
      },
      {
        binding: "legacy row before restart",
        sessionId: "same-session",
        lifecycleRevision: undefined,
        sessionStartedAt: 150,
        expectedChild: false,
      },
      {
        binding: "current lifecycle",
        sessionId: "same-session",
        lifecycleRevision: "current",
        sessionStartedAt: 50,
        expectedChild: true,
      },
    ].flatMap((binding) =>
      ["requester", "target"].map((direction) => Object.assign({}, binding, { direction })),
    ),
  )(
    "binds $direction ACP coordination to its loaded entry for $binding",
    async ({ direction, sessionId, lifecycleRevision, sessionStartedAt, expectedChild }) => {
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
      const calls: GatewayCall[] = [];
      callGatewayMock.mockImplementation(async (request: GatewayCall) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "bound-metadata-run", status: "accepted" };
        }
        if (request.method === "agent.wait") {
          return {
            status: "ok",
            terminalReply: { disposition: "visible", text: "Requested result" },
          };
        }
        return {};
      });
      const result = await createSendTool(requesterKey).execute("bound-acp-coordination", {
        sessionKey: targetKey,
        message: "Return the requested result",
        timeoutSeconds: 1,
      });
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(result.details).toMatchObject({
        status: "ok",
        reply: "Requested result",
        delivery: { status: expectedChild ? "skipped" : "pending" },
      });
      const firstAgentCall = calls.find((call) => call.method === "agent");
      expect(agentParams(firstAgentCall ?? {}).inputProvenance?.sourceRole).toBe(
        direction === "requester" && expectedChild ? "subagent" : undefined,
      );
      expect(calls.filter((call) => call.method === "agent")).toHaveLength(expectedChild ? 1 : 6);
    },
  );

  it.each([
    {
      name: "parent to hidden child",
      requesterKey: "agent:main:main",
      targetKey: "agent:main:subagent:child",
      childKeys: ["agent:main:subagent:child"],
    },
    {
      name: "parent to visible child",
      requesterKey: "agent:main:main",
      targetKey: "agent:penny:dashboard:child",
      childKeys: ["agent:penny:dashboard:child"],
    },
    {
      name: "hidden child to parent",
      requesterKey: "agent:main:subagent:child",
      targetKey: "agent:main:main",
      childKeys: ["agent:main:subagent:child"],
    },
    {
      name: "visible child to parent",
      requesterKey: "agent:penny:dashboard:child",
      targetKey: "agent:main:main",
      childKeys: ["agent:penny:dashboard:child"],
    },
    {
      name: "ACP child to parent",
      requesterKey: "agent:penny:acp:child",
      targetKey: "agent:main:main",
      childKeys: ["agent:penny:acp:child"],
    },
    {
      name: "sibling children",
      requesterKey: "agent:main:subagent:child",
      targetKey: "agent:penny:dashboard:sibling",
      childKeys: ["agent:main:subagent:child", "agent:penny:dashboard:sibling"],
    },
    {
      name: "unrelated coordinator to child",
      requesterKey: "agent:director:main",
      targetKey: "agent:main:subagent:child",
      childKeys: ["agent:main:subagent:child"],
    },
  ])(
    "sessions_send returns one reply without reciprocal turns for $name",
    async ({ requesterKey, targetKey, childKeys }) => {
      const calls: GatewayCall[] = [];
      for (const sessionKey of childKeys) {
        await writeEntry(sessionKey, {
          sessionId: `session-${sessionKey}`,
          updatedAt: 1,
          spawnedBy: "agent:main:main",
          spawnDepth: 1,
        });
      }
      callGatewayMock.mockImplementation(async (request: GatewayCall) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-child", status: "accepted", acceptedAt: 2000 };
        }
        if (request.method === "agent.wait") {
          return {
            status: "ok",
            terminalReply: { disposition: "visible", text: "Requested result" },
          };
        }
        return {};
      });
      const finalAnnounce = vi.fn(async () => ({
        payloads: [{ text: "ANNOUNCE_SKIP", mediaUrl: null }],
        meta: { durationMs: 1 },
      }));
      agentStepTesting.setDepsForTest({ agentCommandFromIngress: finalAnnounce });
      const tool = createSendTool(requesterKey);
      const result = await tool.execute("child-coordination", {
        sessionKey: targetKey,
        message: "Share the requested result",
        timeoutSeconds: 1,
      });
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(result.details).toMatchObject({
        status: "ok",
        reply: "Requested result",
        delivery: { status: "skipped", mode: "announce" },
      });
      expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
      expect(
        agentParams(calls.find((call) => call.method === "agent") ?? {}).extraSystemPrompt,
      ).toBeUndefined();
      expect(finalAnnounce).not.toHaveBeenCalled();
      expect(calls.some((call) => call.method === "send")).toBe(false);
    },
  );

  it.each(
    [
      {
        name: "hidden child",
        requesterKey: "agent:main:subagent:child",
        entry: { spawnedBy: "agent:main:main" },
      },
      {
        name: "hidden child with opaque direct token under main DM scope",
        requesterKey: "agent:main:subagent:direct:peer-1",
        targetKey: "agent:peer:main",
        entry: {},
      },
      {
        name: "visible child",
        requesterKey: "agent:main:dashboard:child",
        entry: { spawnedBy: "agent:main:main", spawnDepth: 1 },
      },
      {
        name: "legacy ACP child",
        requesterKey: "agent:main:acp:child",
        entry: { parentSessionKey: "agent:main:main" },
        acpMeta: { backend: "acpx" },
      },
    ].flatMap((source) =>
      [0, 1].map((timeoutSeconds) => Object.assign({}, source, { timeoutSeconds })),
    ),
  )(
    "sessions_send does not start reply turns for $name after timeoutSeconds=$timeoutSeconds",
    async ({ requesterKey, entry, timeoutSeconds, targetKey = "agent:main:main", acpMeta }) => {
      const calls: GatewayCall[] = [];
      await writeEntry(requesterKey, { sessionId: "child", updatedAt: 1, ...entry });
      readAcpSessionMetaMock.mockImplementation((params: { sessionKey?: string }) =>
        params.sessionKey === requesterKey ? acpMeta : undefined,
      );
      callGatewayMock.mockImplementation(async (request: GatewayCall) => {
        calls.push(request);
        if (request.method === "agent") {
          return { status: "accepted", runId: "parent-report" };
        }
        if (request.method === "agent.wait") {
          return { status: "timeout" };
        }
        return {};
      });
      const tool = createSendTool(requesterKey);
      const result = await tool.execute("child-report", {
        sessionKey: targetKey,
        message: "The requested repair is ready for review.",
        timeoutSeconds,
      });
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

  it.each([
    { name: "dashboard threading", staleAcp: false },
    { name: "stale ACP shadow", staleAcp: true },
  ])(
    "sessions_send keeps peer A2A for $name without canonical child ownership",
    async ({ staleAcp }) => {
      const requesterKey = "agent:main:dashboard:parent-uuid";
      const targetKey = staleAcp ? "agent:main:acp:stale" : "agent:main:dashboard:thread-uuid";
      await writeEntry(targetKey, {
        sessionId: "thread-session",
        updatedAt: 1,
        parentSessionKey: requesterKey,
        ...(staleAcp
          ? {
              acp: {
                backend: "acpx",
                agent: "main",
                runtimeSessionName: "retired-shadow",
                mode: "persistent",
                state: "idle",
                lastActivityAt: 1,
              } as const,
            }
          : {}),
      });
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        if (request.method === "agent") {
          return { runId: "run-thread", status: "accepted", acceptedAt: 2000 };
        }
        if (request.method === "agent.wait") {
          return {
            runId: "run-thread",
            status: "ok",
            terminalReply: { disposition: "visible", text: "thread reply" },
          };
        }
        return {};
      });

      const tool = createSendTool(requesterKey);
      const waited = await tool.execute("call-dashboard-thread", {
        sessionKey: targetKey,
        message: "ping",
        timeoutSeconds: 1,
      });

      const waitedDetails = sessionsSendDetails(waited.details);
      expect(waitedDetails.reply).toBe("thread reply");
      expect(waitedDetails.delivery?.status).toBe("pending");
    },
  );
});
