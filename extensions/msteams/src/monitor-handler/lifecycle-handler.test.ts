// Msteams tests cover lifecycle session reset behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConversationStore } from "../conversation-store.js";
import {
  createMSTeamsMessageHandlerDeps,
  installMSTeamsTestRuntime,
} from "../monitor-handler.test-helpers.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

const hoisted = vi.hoisted(() => {
  const listSessionEntries = vi.fn();
  const patchSessionEntry = vi.fn();
  const resolveStorePath = vi.fn(() => "/tmp/openclaw-msteams-sessions.json");
  return { listSessionEntries, patchSessionEntry, resolveStorePath };
});

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    listSessionEntries: hoisted.listSessionEntries,
    patchSessionEntry: hoisted.patchSessionEntry,
    resolveStorePath: hoisted.resolveStorePath,
  };
});

let handleMSTeamsLifecycleRemove: typeof import("./lifecycle-handler.js").handleMSTeamsLifecycleRemove;

type SessionEntry = {
  sessionId?: string;
  updatedAt: number;
};

function setupStore(store: Record<string, SessionEntry>) {
  hoisted.listSessionEntries.mockImplementation(() =>
    Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry })),
  );
  hoisted.patchSessionEntry.mockImplementation(
    async (params: {
      sessionKey: string;
      update: (entry: SessionEntry) => SessionEntry | null;
    }) => {
      const entry = store[params.sessionKey];
      if (!entry) {
        return null;
      }
      const next = params.update({ ...entry });
      if (!next) {
        return entry;
      }
      store[params.sessionKey] = next;
      return next;
    },
  );
}

function createDeps(remove = vi.fn(async () => true)) {
  const deps = createMSTeamsMessageHandlerDeps();
  deps.conversationStore = {
    ...deps.conversationStore,
    remove,
  } as MSTeamsConversationStore;
  return { deps, remove };
}

function createContext(activity: Record<string, unknown>): MSTeamsTurnContext {
  return {
    activity: activity as MSTeamsTurnContext["activity"],
    sendActivity: vi.fn(async () => ({ id: "sent" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "updated" })),
    deleteActivity: vi.fn(async () => undefined),
  };
}

describe("handleMSTeamsLifecycleRemove", () => {
  beforeAll(async () => {
    ({ handleMSTeamsLifecycleRemove } = await import("./lifecycle-handler.js"));
  });

  beforeEach(() => {
    installMSTeamsTestRuntime();
    hoisted.listSessionEntries.mockReset();
    hoisted.patchSessionEntry.mockReset();
    hoisted.resolveStorePath.mockClear();
    hoisted.resolveStorePath.mockReturnValue("/tmp/openclaw-msteams-sessions.json");
  });

  it("stales a personal app remove session and removes the cached conversation reference", async () => {
    const store = {
      "msteams:direct:user-aad": { sessionId: "old-session", updatedAt: 1_000 },
      "msteams:direct:other-user": { sessionId: "other-session", updatedAt: 2_000 },
    };
    setupStore(store);
    const { deps, remove } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "remove",
        from: { id: "user-bf", aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:personal-chat;messageid=ignored",
          conversationType: "personal",
        },
      }),
      deps,
    );

    expect(result).toEqual({
      handled: true,
      reason: "installation-remove",
      conversationRemoved: true,
      sessionsReset: 1,
    });
    expect(remove).toHaveBeenCalledWith("19:personal-chat");
    expect(store["msteams:direct:user-aad"].updatedAt).toBe(0);
    expect(store["msteams:direct:other-user"].updatedAt).toBe(2_000);
  });

  it("treats remove-upgrade as a removal boundary", async () => {
    const store = {
      "msteams:direct:user-aad": { sessionId: "old-session", updatedAt: 1_000 },
    };
    setupStore(store);
    const { deps } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "remove-upgrade",
        from: { id: "user-bf", aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:personal-chat",
          conversationType: "personal",
        },
      }),
      deps,
    );

    expect(result.sessionsReset).toBe(1);
    expect(store["msteams:direct:user-aad"].updatedAt).toBe(0);
  });

  it("ignores installation add events", async () => {
    const store = {
      "msteams:direct:user-aad": { sessionId: "old-session", updatedAt: 1_000 },
    };
    setupStore(store);
    const { deps, remove } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "add",
        from: { id: "user-bf", aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:personal-chat",
          conversationType: "personal",
        },
      }),
      deps,
    );

    expect(result.handled).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(hoisted.listSessionEntries).not.toHaveBeenCalled();
    expect(store["msteams:direct:user-aad"].updatedAt).toBe(1_000);
  });

  it("stales a channel removal base session and channel thread sessions", async () => {
    const channelId = "19:team-channel@thread.tacv2";
    const baseKey = `msteams:channel:${channelId}`;
    const threadKey = `${baseKey}:thread:root-message`;
    const unrelatedKey = "msteams:channel:19:other-channel@thread.tacv2";
    const store = {
      [baseKey]: { sessionId: "base", updatedAt: 1_000 },
      [threadKey]: { sessionId: "thread", updatedAt: 2_000 },
      [unrelatedKey]: { sessionId: "other", updatedAt: 3_000 },
    };
    setupStore(store);
    const { deps, remove } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "conversationUpdate",
        from: { id: "teams-service" },
        recipient: { id: "bot-id" },
        membersRemoved: [{ id: "bot-id" }],
        conversation: {
          id: channelId,
          conversationType: "channel",
        },
        channelData: {
          team: { id: "team-id" },
          eventType: "teamMemberRemoved",
        },
      }),
      deps,
    );

    expect(result).toMatchObject({
      handled: true,
      reason: "bot-members-removed",
      conversationRemoved: true,
      sessionsReset: 2,
    });
    expect(remove).toHaveBeenCalledWith(channelId);
    expect(store[baseKey].updatedAt).toBe(0);
    expect(store[threadKey].updatedAt).toBe(0);
    expect(store[unrelatedKey].updatedAt).toBe(3_000);
  });

  it("ignores membersRemoved events that do not remove the bot", async () => {
    const store = {
      "msteams:channel:19:team-channel@thread.tacv2": {
        sessionId: "base",
        updatedAt: 1_000,
      },
    };
    setupStore(store);
    const { deps, remove } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "conversationUpdate",
        recipient: { id: "bot-id" },
        membersRemoved: [{ id: "user-id" }],
        conversation: {
          id: "19:team-channel@thread.tacv2",
          conversationType: "channel",
        },
      }),
      deps,
    );

    expect(result.handled).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(hoisted.listSessionEntries).not.toHaveBeenCalled();
    expect(store["msteams:channel:19:team-channel@thread.tacv2"].updatedAt).toBe(1_000);
  });

  it("does not reset a matching session that changed after the list snapshot", async () => {
    const store = {
      "msteams:direct:user-aad": {
        sessionId: "fresh-session",
        updatedAt: 2_000,
      },
    };
    setupStore(store);
    hoisted.listSessionEntries.mockReturnValue([
      {
        sessionKey: "msteams:direct:user-aad",
        entry: {
          sessionId: "old-session",
          updatedAt: 1_000,
        },
      },
    ]);
    const { deps } = createDeps();

    const result = await handleMSTeamsLifecycleRemove(
      createContext({
        type: "installationUpdate",
        action: "remove",
        from: { id: "user-bf", aadObjectId: "user-aad" },
        recipient: { id: "bot-id" },
        conversation: {
          id: "19:personal-chat",
          conversationType: "personal",
        },
      }),
      deps,
    );

    expect(result.sessionsReset).toBe(0);
    expect(store["msteams:direct:user-aad"].updatedAt).toBe(2_000);
    expect(store["msteams:direct:user-aad"].sessionId).toBe("fresh-session");
  });
});
