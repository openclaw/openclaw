import { sessionCatalogAdoptedSessionKey } from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { CODEX_CLI_SESSION_SOURCE_CAPABILITY } from "./node-cli-sessions.js";
import {
  CODEX_NODE_SESSION_KEY_PREFIX,
  readNodeSessionMarker,
} from "./session-catalog-node-adoption.js";
import {
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_NODE_CONTINUE_COMMANDS,
  createCodexTestBindingStore,
  createControl,
  createGatewayApi,
  createRuntime,
  registerCodexSessionCatalog,
  transcriptMirrorMocks,
  type OpenClawConfig,
  type PluginRuntime,
} from "./session-catalog.test-helpers.js";

const homeA = "a".repeat(64);
const homeB = "b".repeat(64);
const nodeId = "source-node";
const hostId = `node:${nodeId}`;
const threadId = "123e4567-e89b-12d3-a456-426614174001";
type EntrySummary = ReturnType<typeof createRuntime>["entries"][number];

function createHomeFixture(entries: EntrySummary[] = []) {
  const wire: {
    sourceHomeId?: string;
    changeHomeBeforeHistory?: string;
    secondPageHome?: string;
  } = { sourceHomeId: homeA };
  const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async ({ command, params }) => {
    const request = isRecord(params) ? params : {};
    if (command === CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND && wire.changeHomeBeforeHistory) {
      wire.sourceHomeId = wire.changeHomeBeforeHistory;
      wire.changeHomeBeforeHistory = undefined;
    }
    if (request.sourceHomeId !== undefined && request.sourceHomeId !== wire.sourceHomeId) {
      throw new Error("Codex node source changed");
    }
    if (command === CODEX_APP_SERVER_THREADS_LIST_COMMAND) {
      const hasSecondPage = wire.secondPageHome !== undefined && request.cursor === undefined;
      const page = {
        sourceHomeId: wire.sourceHomeId,
        canContinueCodex: true,
        sessions: hasSecondPage
          ? []
          : [{ threadId, name: "Copied task", status: "idle", source: "cli", archived: false }],
        ...(hasSecondPage ? { nextCursor: "second-page" } : {}),
      };
      if (hasSecondPage) {
        wire.sourceHomeId = wire.secondPageHome;
      }
      return { payloadJSON: JSON.stringify(page) };
    }
    if (command === CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND) {
      const historyId = wire.sourceHomeId === homeA ? "history-a" : "history-b";
      return {
        payloadJSON: JSON.stringify({
          data: [
            {
              id: historyId,
              status: "completed",
              items: [{ id: `${historyId}-item`, type: "agentMessage", text: historyId }],
            },
          ],
        }),
      };
    }
    throw new Error(`unexpected node command: ${command}`);
  });
  const runtimeFixture = createRuntime({
    entries,
    nodes: [
      {
        nodeId,
        connected: true,
        caps: [CODEX_CLI_SESSION_SOURCE_CAPABILITY],
        commands: [...CODEX_NODE_CONTINUE_COMMANDS],
        invocableCommands: [...CODEX_NODE_CONTINUE_COMMANDS],
      },
    ],
    invoke,
  });
  vi.spyOn(runtimeFixture.runtime.agent.session, "getSessionEntry").mockImplementation(
    ({ sessionKey }) =>
      runtimeFixture.entries.find((candidate) => candidate.sessionKey === sessionKey)?.entry,
  );
  const config: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
  const { api, getProvider } = createGatewayApi(runtimeFixture.runtime, config);
  registerCodexSessionCatalog({
    api,
    bindingStore: createCodexTestBindingStore(),
    control: createControl(),
    getRuntimeConfig: () => config,
  });
  const provider = getProvider();
  const continueSession = provider?.continueSession;
  if (!provider || !continueSession) {
    throw new Error("Codex continuation provider did not register");
  }
  return {
    ...runtimeFixture,
    invoke,
    provider,
    wire,
    continueAt: (sourceHomeId?: string) =>
      continueSession({
        hostId,
        threadId,
        ...(sourceHomeId ? { sourceHomeId } : {}),
        clientScopes: ["operator.admin"],
      }),
    entry: (sessionKey: string) => {
      const summary = runtimeFixture.entries.find(
        (candidate) => candidate.sessionKey === sessionKey,
      );
      if (!summary) {
        throw new Error("missing adopted session entry");
      }
      return summary.entry;
    },
  };
}

describe("paired-node Codex home ownership", () => {
  it("keeps copied thread ids in different homes in separate chats with their own history", async () => {
    const fixture = createHomeFixture();
    const first = await fixture.continueAt(homeA);
    await first.afterConversationBound?.();
    fixture.wire.sourceHomeId = homeB;

    const changed = await fixture.provider.list({ hostIds: [hostId] });
    expect(changed[0]?.sessions[0]?.sessionKey).toBeUndefined();
    const second = await fixture.continueAt(homeB);
    await second.afterConversationBound?.();

    expect(second.sessionKey).not.toBe(first.sessionKey);
    expect(fixture.createSessionEntry).toHaveBeenCalledTimes(2);
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledTimes(2);
    for (const [index, adopted, sourceHomeId, historyId] of [
      [1, first, homeA, "history-a"],
      [2, second, homeB, "history-b"],
    ] as const) {
      expect(readNodeSessionMarker(fixture.entry(adopted.sessionKey))).toMatchObject({
        sourceHomeId,
      });
      expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenNthCalledWith(
        index,
        expect.objectContaining({
          sessionKey: adopted.sessionKey,
          thread: expect.objectContaining({ turns: [expect.objectContaining({ id: historyId })] }),
        }),
      );
      fixture.wire.sourceHomeId = sourceHomeId;
      const listed = await fixture.provider.list({ hostIds: [hostId] });
      expect(listed[0]?.sessions[0]).toMatchObject({
        sourceHomeId,
        sessionKey: adopted.sessionKey,
      });
    }
  });

  it("rejects a stale home locator before reusing or creating an adopted chat", async () => {
    const fixture = createHomeFixture();
    const adopted = await fixture.continueAt(homeA);
    await adopted.afterConversationBound?.();
    fixture.wire.sourceHomeId = homeB;
    fixture.createSessionEntry.mockClear();
    transcriptMirrorMocks.importCodexThreadHistoryToTranscript.mockClear();

    await expect(fixture.continueAt(homeA)).rejects.toThrow(/source/i);
    expect(fixture.createSessionEntry).not.toHaveBeenCalled();
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).not.toHaveBeenCalled();
    expect(readNodeSessionMarker(fixture.entry(adopted.sessionKey))).toMatchObject({
      sourceHomeId: homeA,
    });
  });

  it("refuses history from a home changed after the eligibility lookup", async () => {
    const fixture = createHomeFixture();
    fixture.wire.changeHomeBeforeHistory = homeB;

    await expect(fixture.continueAt(homeA)).rejects.toThrow(/source/i);
    expect(fixture.createSessionEntry).not.toHaveBeenCalled();
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).not.toHaveBeenCalled();
  });

  it("keeps an unqualified paginated lookup on its first source home", async () => {
    const fixture = createHomeFixture();
    fixture.wire.secondPageHome = homeB;

    await expect(fixture.continueAt()).rejects.toThrow(/source/i);
    expect(fixture.createSessionEntry).not.toHaveBeenCalled();
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).not.toHaveBeenCalled();
  });

  it("keeps source-less node pages readable without allowing a new adoption", async () => {
    const fixture = createHomeFixture();
    fixture.wire.sourceHomeId = undefined;

    expect(await fixture.provider.list({ hostIds: [hostId] })).toMatchObject([
      { sessions: [{ threadId, name: "Copied task", canContinue: false }] },
    ]);
    await expect(fixture.continueAt()).rejects.toThrow(/source|update/i);
    expect(fixture.createSessionEntry).not.toHaveBeenCalled();
  });

  it.each([
    { phase: "update", home: "changed", sourceHomeId: homeB, allowed: false },
    { phase: "reconcile", home: "changed", sourceHomeId: homeB, allowed: false },
    { phase: "reconcile", home: "same", sourceHomeId: homeA, allowed: true },
  ] as const)(
    "finalizes during $phase only for the $home home",
    async ({ phase, sourceHomeId, allowed }) => {
      const fixture = createHomeFixture();
      const adopted = await fixture.continueAt(homeA);
      const entry = fixture.entry(adopted.sessionKey);
      entry.archivedAt = allowed ? undefined : 123;
      entry.pluginExtensions = {
        codex: {
          sessionCatalog: {
            sourceHostId: hostId,
            sourceThreadId: threadId,
            nodeId,
            sourceHomeId,
            ...(phase === "update" ? { initializing: true } : {}),
          },
        },
      };
      if (phase === "reconcile") {
        fixture.patchSessionEntry.mockRejectedValueOnce(new Error("finalization receipt lost"));
      }

      if (allowed) {
        await expect(adopted.afterConversationBound?.()).resolves.toBeUndefined();
      } else {
        await expect(adopted.afterConversationBound?.()).rejects.toThrow(
          phase === "update" ? "changed before it could be bound" : "finalization receipt lost",
        );
      }
      expect(entry.archivedAt).toBe(allowed ? undefined : 123);
      expect(entry.pluginExtensions?.codex).toMatchObject({
        sessionCatalog: { sourceHomeId },
      });
    },
  );

  it("preserves a shipped source-less marker while explicit re-adoption creates a pinned chat", async () => {
    const marker = { sourceHostId: hostId, sourceThreadId: threadId, nodeId };
    const legacyKey = `agent:main:${sessionCatalogAdoptedSessionKey(
      CODEX_NODE_SESSION_KEY_PREFIX,
      JSON.stringify([hostId, threadId]),
    )}`;
    const legacy: EntrySummary = {
      sessionKey: legacyKey,
      entry: {
        sessionId: "legacy-node-chat",
        updatedAt: 1,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        pluginExtensions: { codex: { sessionCatalog: marker } },
      },
    };
    const fixture = createHomeFixture([legacy]);
    const original = structuredClone(legacy);
    expect(readNodeSessionMarker(legacy.entry)).toEqual(marker);

    const adopted = await fixture.continueAt(homeA);
    await adopted.afterConversationBound?.();

    expect(adopted.sessionKey).not.toBe(legacyKey);
    expect(legacy).toEqual(original);
    expect(fixture.entries).toHaveLength(2);
    expect(readNodeSessionMarker(fixture.entry(adopted.sessionKey))).toMatchObject({
      sourceHomeId: homeA,
      sourceHostId: hostId,
      sourceThreadId: threadId,
    });
    expect(fixture.createSessionEntry).toHaveBeenCalledOnce();
    expect(
      transcriptMirrorMocks.importCodexThreadHistoryToTranscript,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionKey: adopted.sessionKey,
        sessionId: fixture.entry(adopted.sessionKey).sessionId,
      }),
    );
  });
});
