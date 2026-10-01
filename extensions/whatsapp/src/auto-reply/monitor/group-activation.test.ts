// Whatsapp tests cover group activation plugin behavior.
import path from "node:path";
import {
  getSessionEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, describe, expect, it, vi } from "vitest";
import { resolveGroupActivationFor } from "./group-activation.js";

const GROUP_CONVERSATION_ID = "123@g.us";
const LEGACY_GROUP_SESSION_KEY = "agent:main:whatsapp:group:123@g.us";
const WORK_GROUP_SESSION_KEY = "agent:main:whatsapp:group:123@g.us:thread:whatsapp-account-work";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync(sessionRoot);
    cleanup();
  });
});
const sessionRoot = tempDirs.make("openclaw-session-");

type SessionStoreEntry = {
  groupActivation?: unknown;
  sessionId?: unknown;
  updatedAt?: unknown;
};

async function makeSessionStore(
  entries: Record<string, unknown> = {},
): Promise<{ storePath: string }> {
  const dir = tempDirs.make("case-", sessionRoot);
  const storePath = path.join(dir, "sessions.json");
  await Promise.all(
    Object.entries(entries as Record<string, SessionEntry>).map(([sessionKey, entry]) =>
      upsertSessionEntry({ storePath, sessionKey, entry }),
    ),
  );
  return {
    storePath,
  };
}

const resolveWorkGroupActivation = (storePath: string) =>
  resolveGroupActivationFor({
    cfg: {
      channels: {
        whatsapp: {
          accounts: {
            work: {},
          },
        },
      },
      session: { store: storePath },
    } as never,
    accountId: "work",
    agentId: "main",
    sessionKey: WORK_GROUP_SESSION_KEY,
    conversationId: GROUP_CONVERSATION_ID,
  });

const expectWorkGroupActivationEntry = async (
  storePath: string,
  assertEntry?: (entry: SessionStoreEntry | undefined) => void,
) => {
  await vi.waitFor(() => {
    const scopedEntry = getSessionEntry({
      storePath,
      sessionKey: WORK_GROUP_SESSION_KEY,
      readConsistency: "latest",
    });
    expect(scopedEntry?.groupActivation).toBe("always");
    assertEntry?.(scopedEntry);
  });
};

const expectNoWorkGroupActivationEntry = (storePath: string) => {
  expect(
    getSessionEntry({
      storePath,
      sessionKey: WORK_GROUP_SESSION_KEY,
      readConsistency: "latest",
    }),
  ).toBeUndefined();
};

const expectResolvedWorkGroupActivation = async (
  storePath: string,
  assertEntry?: (entry: SessionStoreEntry | undefined) => void,
) => {
  const activation = await resolveWorkGroupActivation(storePath);
  expect(activation).toBe("always");
  await expectWorkGroupActivationEntry(storePath, assertEntry);
};

describe("resolveGroupActivationFor", () => {
  it("reads legacy named-account group activation without synthesizing a scoped session", async () => {
    const { storePath } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
        sessionId: "legacy-session",
        updatedAt: 123,
      },
    });

    const activation = await resolveWorkGroupActivation(storePath);
    expect(activation).toBe("always");
    expectNoWorkGroupActivationEntry(storePath);
  });

  it("preserves legacy group activation when the scoped entry already exists without activation", async () => {
    const { storePath } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
        sessionId: "legacy-session",
      },
      [WORK_GROUP_SESSION_KEY]: {
        sessionId: "scoped-session",
      },
    });

    await expectResolvedWorkGroupActivation(storePath, (scopedEntry) => {
      expect(scopedEntry?.sessionId).toBe("scoped-session");
    });
  });

  it("does not wake the default account from a work-account scoped group activation", async () => {
    const { storePath } = await makeSessionStore({
      [WORK_GROUP_SESSION_KEY]: {
        groupActivation: "always",
        sessionId: "work-session",
      },
    });

    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "*": {
              requireMention: true,
            },
          },
          accounts: {
            work: {},
          },
        },
      },
      session: { store: storePath },
    } as never;

    const workActivation = await resolveGroupActivationFor({
      cfg,
      accountId: "work",
      agentId: "main",
      sessionKey: WORK_GROUP_SESSION_KEY,
      conversationId: GROUP_CONVERSATION_ID,
    });

    expect(workActivation).toBe("always");

    const defaultActivation = await resolveGroupActivationFor({
      cfg,
      accountId: "default",
      agentId: "main",
      sessionKey: LEGACY_GROUP_SESSION_KEY,
      conversationId: GROUP_CONVERSATION_ID,
    });

    expect(defaultActivation).toBe("mention");
    await expectWorkGroupActivationEntry(storePath);
  });

  it("does not treat mixed-case default account keys as named accounts", async () => {
    const { storePath } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
        sessionId: "legacy-session",
      },
    });

    const activation = await resolveGroupActivationFor({
      cfg: {
        channels: {
          whatsapp: {
            groups: {
              "*": {
                requireMention: true,
              },
            },
            accounts: {
              Default: {},
            },
          },
        },
        session: { store: storePath },
      } as never,
      accountId: "default",
      agentId: "main",
      sessionKey: LEGACY_GROUP_SESSION_KEY,
      conversationId: GROUP_CONVERSATION_ID,
    });

    expect(activation).toBe("always");
  });
});
