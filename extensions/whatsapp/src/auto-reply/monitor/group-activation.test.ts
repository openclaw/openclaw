import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getSessionEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, describe, expect, it } from "vitest";
import { resolveGroupActivationFor } from "./group-activation.js";

const GROUP_CONVERSATION_ID = "123@g.us";
const DEFAULT_GROUP_SESSION_KEY = "agent:main:whatsapp:group:123@g.us";
const WORK_GROUP_SESSION_KEY = `${DEFAULT_GROUP_SESSION_KEY}:thread:whatsapp-account-work`;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync(sessionRoot);
    cleanup();
  });
});
const sessionRoot = tempDirs.make("openclaw-group-activation-");

async function makeSessionStore(entries: Record<string, SessionEntry>) {
  const storePath = path.join(tempDirs.make("case-", sessionRoot), "sessions.json");
  await Promise.all(
    Object.entries(entries).map(([sessionKey, entry]) =>
      upsertSessionEntry({ storePath, sessionKey, entry }),
    ),
  );
  return storePath;
}

function config(storePath: string, requireMention: boolean): OpenClawConfig {
  return {
    channels: {
      whatsapp: {
        groups: { "*": { requireMention } },
        accounts: { Default: {}, work: {} },
      },
    },
    session: { store: storePath },
  };
}

function readEntries(storePath: string) {
  return [DEFAULT_GROUP_SESSION_KEY, WORK_GROUP_SESSION_KEY].map((sessionKey) =>
    getSessionEntry({ storePath, agentId: "main", sessionKey }),
  );
}

describe("resolveGroupActivationFor", () => {
  it.each([
    { requireMention: true, scoped: false },
    { requireMention: false, scoped: true },
  ])(
    "uses configured policy without copying unscoped activation ($requireMention, $scoped)",
    async ({ requireMention, scoped }) => {
      const storePath = await makeSessionStore({
        [DEFAULT_GROUP_SESSION_KEY]: {
          sessionId: "older-unscoped-session",
          updatedAt: 123,
          groupActivation: requireMention ? "always" : "mention",
          label: "retained unscoped metadata",
        },
        ...(scoped
          ? {
              [WORK_GROUP_SESSION_KEY]: {
                sessionId: "work-session",
                updatedAt: 456,
                label: "retained scoped metadata",
              },
            }
          : {}),
      });
      const before = readEntries(storePath);

      expect(
        await resolveGroupActivationFor({
          cfg: config(storePath, requireMention),
          accountId: "work",
          agentId: "main",
          sessionKey: WORK_GROUP_SESSION_KEY,
          conversationId: GROUP_CONVERSATION_ID,
        }),
      ).toBe(requireMention ? "mention" : "always");
      expect(readEntries(storePath)).toEqual(before);
    },
  );

  it.each(["always", "mention"] as const)(
    "preserves canonical named and default activation %s",
    async (activation) => {
      const storePath = await makeSessionStore({
        [DEFAULT_GROUP_SESSION_KEY]: {
          sessionId: "default-session",
          updatedAt: 123,
          groupActivation: activation,
        },
        [WORK_GROUP_SESSION_KEY]: {
          sessionId: "work-session",
          updatedAt: 456,
          groupActivation: activation,
        },
      });
      const before = readEntries(storePath);
      const cfg = config(storePath, activation === "always");
      for (const scope of [
        { accountId: "default", sessionKey: DEFAULT_GROUP_SESSION_KEY },
        { accountId: "work", sessionKey: WORK_GROUP_SESSION_KEY },
      ]) {
        expect(
          await resolveGroupActivationFor({
            cfg,
            ...scope,
            agentId: "main",
            conversationId: GROUP_CONVERSATION_ID,
          }),
        ).toBe(activation);
      }
      expect(readEntries(storePath)).toEqual(before);
      const updatedActivation = activation === "always" ? "mention" : "always";
      await upsertSessionEntry({
        storePath,
        sessionKey: WORK_GROUP_SESSION_KEY,
        entry: {
          sessionId: "work-session",
          updatedAt: 789,
          groupActivation: updatedActivation,
        },
      });
      expect(
        await resolveGroupActivationFor({
          cfg,
          accountId: "work",
          sessionKey: WORK_GROUP_SESSION_KEY,
          agentId: "main",
          conversationId: GROUP_CONVERSATION_ID,
        }),
      ).toBe(updatedActivation);
    },
  );

  it("does not use a named account's activation for the default account", async () => {
    const storePath = await makeSessionStore({
      [WORK_GROUP_SESSION_KEY]: {
        sessionId: "work-session",
        updatedAt: 123,
        groupActivation: "always",
      },
    });
    const before = readEntries(storePath);
    expect(
      await resolveGroupActivationFor({
        cfg: config(storePath, true),
        accountId: "default",
        agentId: "main",
        sessionKey: DEFAULT_GROUP_SESSION_KEY,
        conversationId: GROUP_CONVERSATION_ID,
      }),
    ).toBe("mention");
    expect(readEntries(storePath)).toEqual(before);
  });
});
