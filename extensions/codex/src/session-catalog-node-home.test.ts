import { sessionCatalogAdoptedSessionKey } from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it, vi } from "vitest";
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
type HomeWire = {
  sourceHomeId?: string;
  changeHomeBeforeHistory?: string;
  secondPageHome?: string;
};
const marker = { sourceHostId: hostId, sourceThreadId: threadId, nodeId };
const importHistory = transcriptMirrorMocks.importCodexThreadHistoryToTranscript;

function createHomeFixture(options: HomeWire = {}, entries: EntrySummary[] = []) {
  const wire: HomeWire = { sourceHomeId: homeA, ...options };
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
      const id = wire.sourceHomeId === homeA ? "history-a" : "history-b";
      return {
        payloadJSON: JSON.stringify({
          data: [
            {
              id,
              status: "completed",
              items: [{ id: `${id}-item`, type: "agentMessage", text: id }],
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
  vi.spyOn(runtimeFixture.runtime.agent.session, "getSessionEntryAsync").mockImplementation(
    async ({ sessionKey }) =>
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
  const continueAt = (sourceHomeId?: string) =>
    continueSession({
      hostId,
      threadId,
      ...(sourceHomeId ? { sourceHomeId } : {}),
      clientScopes: ["operator.admin"],
    });
  return {
    ...runtimeFixture,
    invoke,
    provider,
    wire,
    continueAt,
    adopt: async (sourceHomeId: string) => {
      const adopted = await continueAt(sourceHomeId);
      await adopted.afterConversationBound?.();
      return adopted;
    },
    expectNoAdoption: () => {
      expect(runtimeFixture.createSessionEntry).not.toHaveBeenCalled();
      expect(importHistory).not.toHaveBeenCalled();
    },
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

it("keeps copied thread ids in different homes in separate chats with their own history", async () => {
  const fixture = createHomeFixture();
  const first = await fixture.adopt(homeA);
  fixture.wire.sourceHomeId = homeB;

  const changed = await fixture.provider.list({ hostIds: [hostId] });
  expect(changed[0]?.sessions[0]?.sessionKey).toBeUndefined();
  const second = await fixture.adopt(homeB);

  expect(second.sessionKey).not.toBe(first.sessionKey);
  expect(fixture.createSessionEntry).toHaveBeenCalledTimes(2);
  expect(importHistory).toHaveBeenCalledTimes(2);
  for (const [index, adopted, sourceHomeId, historyId] of [
    [1, first, homeA, "history-a"],
    [2, second, homeB, "history-b"],
  ] as const) {
    expect(readNodeSessionMarker(fixture.entry(adopted.sessionKey))).toMatchObject({
      sourceHomeId,
    });
    expect(importHistory).toHaveBeenNthCalledWith(
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
  const adopted = await fixture.adopt(homeA);
  fixture.wire.sourceHomeId = homeB;
  fixture.createSessionEntry.mockClear();
  importHistory.mockClear();

  await expect(fixture.continueAt(homeA)).rejects.toThrow(/source/i);
  fixture.expectNoAdoption();
  expect(readNodeSessionMarker(fixture.entry(adopted.sessionKey))).toMatchObject({
    sourceHomeId: homeA,
  });
});

it.each([
  ["history after eligibility lookup", { changeHomeBeforeHistory: homeB }, homeA],
  ["unqualified lookup between pages", { secondPageHome: homeB }, undefined],
] as const)("rejects a home change during %s", async (_name, wire, locator) => {
  const fixture = createHomeFixture(wire);
  await expect(fixture.continueAt(locator)).rejects.toThrow(/source/i);
  fixture.expectNoAdoption();
});

it("keeps source-less node pages readable without allowing a new adoption", async () => {
  const fixture = createHomeFixture({ sourceHomeId: undefined });

  expect(await fixture.provider.list({ hostIds: [hostId] })).toMatchObject([
    { sessions: [{ threadId, name: "Copied task", canContinue: false }] },
  ]);
  await expect(fixture.continueAt()).rejects.toThrow(/source|update/i);
  expect(fixture.createSessionEntry).not.toHaveBeenCalled();
});

it.each(["update", "reconcile"] as const)(
  "rejects finalization during %s for a changed home",
  async (phase) => {
    const fixture = createHomeFixture();
    const adopted = await fixture.continueAt(homeA);
    const entry = fixture.entry(adopted.sessionKey);
    entry.archivedAt = 123;
    entry.pluginExtensions = {
      codex: {
        sessionCatalog: {
          ...marker,
          sourceHomeId: homeB,
          ...(phase === "update" ? { initializing: true } : {}),
        },
      },
    };
    if (phase === "reconcile") {
      fixture.patchSessionEntry.mockRejectedValueOnce(new Error("finalization receipt lost"));
    }

    await expect(adopted.afterConversationBound?.()).rejects.toThrow(
      phase === "update" ? "changed before it could be bound" : "finalization receipt lost",
    );
    expect(entry).toMatchObject({
      archivedAt: 123,
      pluginExtensions: { codex: { sessionCatalog: { sourceHomeId: homeB } } },
    });
  },
);

it("preserves a shipped source-less marker while explicit re-adoption creates a pinned chat", async () => {
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
  const fixture = createHomeFixture({}, [legacy]);
  const original = structuredClone(legacy);
  expect(readNodeSessionMarker(legacy.entry)).toEqual(marker);

  const adopted = await fixture.adopt(homeA);

  expect(adopted.sessionKey).not.toBe(legacyKey);
  expect(legacy).toEqual(original);
  expect(fixture.entries).toHaveLength(2);
  expect(readNodeSessionMarker(fixture.entry(adopted.sessionKey))).toMatchObject({
    sourceHomeId: homeA,
    sourceHostId: hostId,
    sourceThreadId: threadId,
  });
  expect(fixture.createSessionEntry).toHaveBeenCalledOnce();
  expect(importHistory).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      sessionKey: adopted.sessionKey,
      sessionId: fixture.entry(adopted.sessionKey).sessionId,
    }),
  );
});
