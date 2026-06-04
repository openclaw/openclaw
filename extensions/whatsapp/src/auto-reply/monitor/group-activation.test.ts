import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionStore } from "../config.runtime.js";
import { resolveGroupActivationFor } from "./group-activation.js";

const GROUP_CONVERSATION_ID = "123@g.us";
const LEGACY_GROUP_SESSION_KEY = "agent:main:whatsapp:group:123@g.us";
const WORK_GROUP_SESSION_KEY = "agent:main:whatsapp:group:123@g.us:thread:whatsapp-account-work";

type SessionStoreEntry = {
  groupActivation?: unknown;
  sessionId?: unknown;
  updatedAt?: unknown;
};

async function makeSessionStore(
  entries: Record<string, unknown> = {},
): Promise<{ storePath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-"));
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(entries));
  return {
    storePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
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

const readWorkGroupEntry = (storePath: string): SessionStoreEntry | undefined => {
  return loadSessionStore(storePath, { skipCache: true })[WORK_GROUP_SESSION_KEY];
};

const expectResolvedWorkGroupActivation = async (
  storePath: string,
  assertEntry?: (entry: SessionStoreEntry | undefined) => void,
) => {
  const activation = await resolveWorkGroupActivation(storePath);
  expect(activation).toBe("always");
  assertEntry?.(readWorkGroupEntry(storePath));
};

describe("resolveGroupActivationFor", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("reads legacy named-account group activation without creating a scoped row", async () => {
    const { storePath, cleanup } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
        sessionId: "legacy-session",
        updatedAt: 123,
      },
    });
    cleanups.push(cleanup);

    await expectResolvedWorkGroupActivation(storePath, (scopedEntry) => {
      expect(scopedEntry).toBeUndefined();
    });
  });

  it("patches legacy group activation onto an existing real scoped entry", async () => {
    const { storePath, cleanup } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
      },
      [WORK_GROUP_SESSION_KEY]: {
        sessionId: "scoped-session",
        updatedAt: 456,
      },
    });
    cleanups.push(cleanup);

    await expectResolvedWorkGroupActivation(storePath, (scopedEntry) => {
      expect(scopedEntry?.sessionId).toBe("scoped-session");
      expect(scopedEntry?.updatedAt).toBe(456);
      expect(scopedEntry?.groupActivation).toBe("always");
    });
  });

  it("does not wake the default account from an activation-only legacy group entry in multi-account setups", async () => {
    const { storePath, cleanup } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
      },
    });
    cleanups.push(cleanup);

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
    expect(readWorkGroupEntry(storePath)).toBeUndefined();
  });

  it("does not treat mixed-case default account keys as named accounts", async () => {
    const { storePath, cleanup } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
      },
    });
    cleanups.push(cleanup);

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
