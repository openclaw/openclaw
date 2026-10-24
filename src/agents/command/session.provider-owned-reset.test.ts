import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";

const hoisted = vi.hoisted(() => ({
  store: {} as Record<string, SessionEntry>,
  terminalTranscriptNewer: false,
}));

// mock-isolation: Provider-reset fixtures read cloned synthetic rows without opening a session store.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: async ({ sessionKey }: { sessionKey: string }) => {
    const entry = hoisted.store[sessionKey];
    return entry ? structuredClone(entry) : undefined;
  },
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: () => "/stores/main.json",
}));

vi.mock("../../config/sessions/lifecycle-read.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/lifecycle-read.js")>(
    "../../config/sessions/lifecycle-read.js",
  );
  return {
    ...actual,
    hasTerminalMainSessionTranscriptNewerThanRegistryAsync: async () =>
      hoisted.terminalTranscriptNewer,
  };
});

const { resolveSession } = await import("./session.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const sessionKey = "agent:main:cli";

function seedSession(sessionId: string, age: number, fields: Partial<SessionEntry> = {}): void {
  hoisted.terminalTranscriptNewer = false;
  const startedAt = Date.now() - age;
  hoisted.store = {
    [sessionKey]: {
      sessionId,
      updatedAt: startedAt,
      sessionStartedAt: startedAt,
      lastInteractionAt: startedAt,
      ...fields,
    },
  };
}

function resolve(session: OpenClawConfig["session"] = {}) {
  return resolveSession({ cfg: { session }, sessionKey, agentId: "main" });
}

function expectRotation(result: Awaited<ReturnType<typeof resolve>>, oldId: string) {
  expect(result).toMatchObject({
    isNewSession: true,
    persistedThinking: "high",
    persistedVerbose: "full",
  });
  expect(result.sessionId).not.toBe(oldId);
}

it("keeps a provider-owned CLI session with the default reset policy", async () => {
  seedSession("old-session-id", DAY_MS, {
    model: "claude-opus-4-6",
    modelProvider: "claude-cli",
    cliSessionBindings: { "claude-cli": { sessionId: "cli-conversation-xyz" } },
  });
  expect(await resolve()).toMatchObject({ isNewSession: false, sessionId: "old-session-id" });
});

it("carries stored thinking and verbose preferences during terminal transcript recovery", async () => {
  seedSession("recovering-session-id", 0, { thinkingLevel: "high", verboseLevel: "full" });
  hoisted.terminalTranscriptNewer = true;
  expectRotation(await resolve(), "recovering-session-id");
});

it("carries preferences across a daily reset", async () => {
  const startedAt = Date.now() - 2 * DAY_MS;
  seedSession("daily-expired-session-id", 2 * DAY_MS, {
    thinkingLevel: "high",
    verboseLevel: "full",
    pendingTranscriptRepair: [{ id: "old-repair", text: "old reply", createdAt: startedAt }],
    lastRunId: "settled-old-run",
    restartRecoveryRequesterSource: {
      agentId: "main",
      sessionKey,
      sessionId: "daily-expired-session-id",
      sourceRunId: "settled-old-run",
      requesterOrigin: { sessionKey, operatorProfileId: "original-requester" },
    },
  });
  const result = await resolve({ reset: { mode: "daily" } });
  expectRotation(result, "daily-expired-session-id");
  expect(result.sessionEntry?.pendingTranscriptRepair).toBeUndefined();
  expect(result.sessionEntry?.lastRunId).toBeUndefined();
  expect(result.sessionEntry?.restartRecoveryRequesterSource).toBeUndefined();
});
