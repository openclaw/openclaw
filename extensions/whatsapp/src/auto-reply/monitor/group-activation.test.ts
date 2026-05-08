import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSessionEntry, upsertSessionEntry } from "../config.runtime.js";
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
): Promise<{ cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-"));
  process.env.OPENCLAW_STATE_DIR = dir;
  for (const [sessionKey, entry] of Object.entries(entries)) {
    upsertSessionEntry({
      agentId: "main",
      sessionKey,
      entry: entry as never,
    });
  }
  return {
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

const resolveWorkGroupActivation = () =>
  resolveGroupActivationFor({
    cfg: {
      channels: {
        whatsapp: {
          accounts: {
            work: {},
          },
        },
      },
      session: {},
    } as never,
    accountId: "work",
    agentId: "main",
    sessionKey: WORK_GROUP_SESSION_KEY,
    conversationId: GROUP_CONVERSATION_ID,
  });

const expectWorkGroupActivationEntry = async (
  assertEntry?: (entry: SessionStoreEntry | undefined) => void,
) => {
  await vi.waitFor(() => {
    const scopedEntry = getSessionEntry({
      agentId: "main",
      sessionKey: WORK_GROUP_SESSION_KEY,
    });
    expect(scopedEntry?.groupActivation).toBe("always");
    assertEntry?.(scopedEntry);
  });
};

const expectResolvedWorkGroupActivation = async (
  assertEntry?: (entry: SessionStoreEntry | undefined) => void,
) => {
  const activation = await resolveWorkGroupActivation();
  expect(activation).toBe("always");
  await expectWorkGroupActivationEntry(assertEntry);
};

describe("resolveGroupActivationFor", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("reads legacy named-account group activation and backfills the scoped key", async () => {
    const { cleanup } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
        sessionId: "legacy-session",
        updatedAt: 123,
      },
    });
    cleanups.push(cleanup);

    await expectResolvedWorkGroupActivation((scopedEntry) => {
      expect(typeof scopedEntry?.sessionId).toBe("string");
      expect(typeof scopedEntry?.updatedAt).toBe("number");
    });
  });

  it("preserves legacy group activation when the scoped entry already exists without activation", async () => {
    const { cleanup } = await makeSessionStore({
      [LEGACY_GROUP_SESSION_KEY]: {
        groupActivation: "always",
      },
      [WORK_GROUP_SESSION_KEY]: {
        sessionId: "scoped-session",
      },
    });
    cleanups.push(cleanup);

    await expectResolvedWorkGroupActivation((scopedEntry) => {
      expect(scopedEntry?.sessionId).toBe("scoped-session");
    });
  });

  it("does not wake the default account from an activation-only legacy group entry in multi-account setups", async () => {
    const { cleanup } = await makeSessionStore({
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
      session: {},
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
    await expectWorkGroupActivationEntry();
  });

  it("does not treat mixed-case default account keys as named accounts", async () => {
    const { cleanup } = await makeSessionStore({
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
        session: {},
      } as never,
      accountId: "default",
      agentId: "main",
      sessionKey: LEGACY_GROUP_SESSION_KEY,
      conversationId: GROUP_CONVERSATION_ID,
    });

    expect(activation).toBe("always");
  });
});
