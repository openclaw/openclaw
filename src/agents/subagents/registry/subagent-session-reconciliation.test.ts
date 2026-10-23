import fs from "node:fs";
import { expect, it } from "vitest";
import type { SessionEntry } from "../../../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  replaceSessionEntrySync,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  loadSubagentSessionEntry as loadEntry,
  resolveSubagentSessionCompletion as readCompletion,
  resolveSubagentSessionStartedAt as readStartedAt,
} from "./subagent-session-reconciliation.js";

const terminalSession: SessionEntry = {
  sessionId: "sibling-session",
  status: "done",
  startedAt: 1_000,
  updatedAt: 2_000,
  endedAt: 2_000,
};

async function expectCompletion(target: Parameters<typeof loadEntry>[0], sessionId: string) {
  expect((await loadEntry(target))?.sessionId).toBe(sessionId);
  expect(await readCompletion({ ...target, fallbackEndedAt: 3_000 })).toMatchObject({
    endedAt: 2_000,
    outcome: { status: "ok" },
  });
  expect(await readStartedAt(target)).toBe(1_000);
}

async function completionFor(childKey: string, storedKey: string, entry = terminalSession) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    replaceSessionEntrySync({ sessionKey: storedKey, env: state.env }, entry);
    return readCompletion({
      childSessionKey: childKey,
      fallbackEndedAt: 3_000,
      notBeforeMs: 0,
      cfg: {},
    });
  });
}

it("matches case-insensitive structural session-key segments", async () => {
  expect(
    await completionFor("Agent:MAIN:telegram:group:ROOM", "agent:main:telegram:group:room"),
  ).toMatchObject({ endedAt: 2_000, outcome: { status: "ok" } });
});

it.each([
  ["Matrix", "agent:main:matrix:group:!Room:server", "agent:main:matrix:group:!room:server"],
  ["Signal", "agent:main:signal:group:AbCdEf==", "agent:main:signal:group:abcdef=="],
])(
  "does not match a case-distinct %s opaque peer",
  async (_channel, childSessionKey, storedSessionKey) => {
    expect(await completionFor(childSessionKey, storedSessionKey)).toBeNull();
  },
);

it.each([
  { status: "failed", outcome: "error" },
  { status: "timeout", outcome: "timeout" },
] as const)(
  "retains the persisted $status diagnostic for parent completion",
  async ({ status, outcome }) => {
    const key = "agent:main:subagent:failed-diagnostic";
    const lastRunError = "The synthetic fixture could not load its assigned document.";
    expect(
      await completionFor(key, key, { ...terminalSession, status, lastRunError }),
    ).toMatchObject({ endedAt: 2_000, outcome: { status: outcome, error: lastRunError } });
    expect(await completionFor(key, key, { ...terminalSession, status })).toMatchObject({
      outcome:
        status === "failed"
          ? { status: "error", error: "session completed before registry settled" }
          : { status: "timeout" },
    });
  },
);

it("does not turn an interrupted outcome with an end timestamp into registry completion", async () => {
  const key = "agent:main:subagent:interrupted";
  expect(await completionFor(key, key, { ...terminalSession, status: "interrupted" })).toBeNull();
});

it.each([undefined, "sessions.json", "custom-sessions.json", "shared.sqlite"])(
  "reconciles each agent in store %s",
  async (file) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = file ? state.path(file) : undefined;
      const cfg: OpenClawConfig = storePath ? { session: { store: storePath } } : {};
      const targets = ["main", "worker"].flatMap((agentId) =>
        [`agent:${agentId}:subagent:child`, "global"].map((sessionKey) => ({
          agentId,
          sessionKey,
        })),
      );
      for (const target of targets) {
        replaceSessionEntrySync(
          { ...target, storePath, env: state.env },
          { ...terminalSession, sessionId: `${target.agentId}-child` },
        );
      }
      for (const { agentId: childAgentId, sessionKey: childSessionKey } of targets) {
        const target = { childSessionKey, childAgentId, cfg };
        // An explicit shared database has one raw-key namespace; the last global write wins.
        const expectedAgent =
          file === "shared.sqlite" && childSessionKey === "global" ? "worker" : childAgentId;
        await expectCompletion(target, `${expectedAgent}-child`);
      }
      for (const [childSessionKey, childAgentId] of [
        ["agent:main:subagent:child", "worker"],
        ["agent:worker:subagent:child", "main"],
        ["agent::subagent:child", "worker"],
        ["global", undefined],
      ] as const) {
        await expect(loadEntry({ childSessionKey, childAgentId, cfg })).rejects.toThrow(
          "Subagent owning agent is unresolved",
        );
      }
    });
  },
);

it.each(["main", "worker"])(
  "keeps %s incognito completion separate from its configured durable store",
  async (agentId) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env });
      const storePath = state.path("custom-sessions.json");
      const cfg = { session: { store: storePath } } satisfies OpenClawConfig;
      const durableKey = `agent:${agentId}:subagent:durable`;
      const childSessionKey = `agent:${agentId}:subagent:incognito-child`;
      replaceSessionEntrySync(
        { agentId, sessionKey: durableKey, storePath, env: state.env },
        { ...terminalSession, sessionId: "durable-child" },
      );
      await replaceSessionEntry(
        { agentId, sessionKey: childSessionKey, storePath, env: state.env },
        { ...terminalSession, sessionId: "incognito-child", incognito: true },
      );

      await expectCompletion({ childSessionKey, cfg }, "incognito-child");
      expect(
        listSessionEntriesReadOnly({ agentId, storePath, env: state.env }).map(
          ({ sessionKey }) => sessionKey,
        ),
      ).toEqual([durableKey]);
      expect(fs.existsSync(incognitoPath)).toBe(false);
    });
  },
);
