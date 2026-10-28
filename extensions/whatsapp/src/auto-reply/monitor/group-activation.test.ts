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
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await upsertSessionEntry({ storePath, sessionKey, entry });
  }
  return storePath;
}

function config(storePath: string, requireMention: boolean): OpenClawConfig {
  return {
    channels: {
      whatsapp: { groups: { "*": { requireMention } }, accounts: { Default: {}, work: {} } },
    },
    session: { store: storePath },
  };
}

function readEntries(storePath: string) {
  return [DEFAULT_GROUP_SESSION_KEY, WORK_GROUP_SESSION_KEY].map((sessionKey) =>
    getSessionEntry({ storePath, agentId: "main", sessionKey }),
  );
}

function session(sessionId: string, updatedAt: number, groupActivation?: "always" | "mention") {
  return { sessionId, updatedAt, ...(groupActivation ? { groupActivation } : {}) };
}

function resolve(cfg: OpenClawConfig, accountId = "work", sessionKey = WORK_GROUP_SESSION_KEY) {
  return resolveGroupActivationFor({
    cfg,
    accountId,
    sessionKey,
    agentId: "main",
    conversationId: GROUP_CONVERSATION_ID,
  });
}

describe("resolveGroupActivationFor", () => {
  it.each([
    { requireMention: true, scoped: false },
    { requireMention: false, scoped: true },
  ])(
    "uses configured policy without copying unscoped activation ($requireMention, $scoped)",
    async ({ requireMention, scoped }) => {
      const storePath = await makeSessionStore({
        [DEFAULT_GROUP_SESSION_KEY]: session(
          "older-unscoped-session",
          123,
          requireMention ? "always" : "mention",
        ),
        ...(scoped && {
          [WORK_GROUP_SESSION_KEY]: session("work-session", 456),
        }),
      });
      const before = readEntries(storePath);

      expect(await resolve(config(storePath, requireMention))).toBe(
        requireMention ? "mention" : "always",
      );
      expect(readEntries(storePath)).toEqual(before);
    },
  );

  it.each(["always", "mention"] as const)(
    "preserves canonical named and default activation %s",
    async (activation) => {
      const storePath = await makeSessionStore({
        [DEFAULT_GROUP_SESSION_KEY]: session("default-session", 123, activation),
        [WORK_GROUP_SESSION_KEY]: session("work-session", 456, activation),
      });
      const before = readEntries(storePath);
      const cfg = config(storePath, activation === "always");
      expect(await resolve(cfg, "default", DEFAULT_GROUP_SESSION_KEY)).toBe(activation);
      expect(await resolve(cfg)).toBe(activation);
      expect(readEntries(storePath)).toEqual(before);
      const updatedActivation = activation === "always" ? "mention" : "always";
      await upsertSessionEntry({
        storePath,
        sessionKey: WORK_GROUP_SESSION_KEY,
        entry: session("work-session", 789, updatedActivation),
      });
      expect(await resolve(cfg)).toBe(updatedActivation);
    },
  );

  it("does not use a named account's activation for the default account", async () => {
    const storePath = await makeSessionStore({
      [WORK_GROUP_SESSION_KEY]: session("work-session", 123, "always"),
    });
    const before = readEntries(storePath);
    expect(await resolve(config(storePath, true), "default", DEFAULT_GROUP_SESSION_KEY)).toBe(
      "mention",
    );
    expect(readEntries(storePath)).toEqual(before);
  });
});
