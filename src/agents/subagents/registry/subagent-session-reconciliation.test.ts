import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesAsync,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  loadSubagentSessionEntry,
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
} from "./subagent-session-reconciliation.js";

const terminalSession: SessionEntry = {
  sessionId: "sibling-session",
  status: "done",
  startedAt: 1_000,
  updatedAt: 2_000,
  endedAt: 2_000,
};

async function resolveCompletion(
  childSessionKey: string,
  storedSessionKey: string,
  entry: SessionEntry = terminalSession,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    replaceSessionEntrySync({ sessionKey: storedSessionKey, env: state.env }, entry);
    return resolveSubagentSessionCompletion({
      childSessionKey,
      fallbackEndedAt: 3_000,
      notBeforeMs: 0,
      cfg: {},
    });
  });
}

describe("subagent session reconciliation keys", () => {
  it("matches case-insensitive structural session-key segments", async () => {
    expect(
      await resolveCompletion("Agent:MAIN:telegram:group:ROOM", "agent:main:telegram:group:room"),
    ).toMatchObject({ endedAt: 2_000, outcome: { status: "ok" } });
  });

  it.each([
    {
      channel: "Matrix",
      childSessionKey: "agent:main:matrix:group:!Room:server",
      storedSessionKey: "agent:main:matrix:group:!room:server",
    },
    {
      channel: "Signal",
      childSessionKey: "agent:main:signal:group:AbCdEf==",
      storedSessionKey: "agent:main:signal:group:abcdef==",
    },
  ])(
    "does not match a case-distinct $channel opaque peer",
    async ({ childSessionKey, storedSessionKey }) => {
      expect(await resolveCompletion(childSessionKey, storedSessionKey)).toBeNull();
    },
  );
});

describe("subagent session reconciliation ownership", () => {
  it.each([
    { status: "failed", outcome: "error" },
    { status: "timeout", outcome: "timeout" },
  ] as const)(
    "retains the persisted $status diagnostic for parent completion",
    async ({ status, outcome }) => {
      const key = "agent:main:subagent:failed-diagnostic";
      const lastRunError = "The synthetic fixture could not load its assigned document.";
      expect(
        await resolveCompletion(key, key, { ...terminalSession, status, lastRunError }),
      ).toMatchObject({ endedAt: 2_000, outcome: { status: outcome, error: lastRunError } });
      expect(await resolveCompletion(key, key, { ...terminalSession, status })).toMatchObject({
        outcome:
          status === "failed"
            ? { status: "error", error: "session completed before registry settled" }
            : { status: "timeout" },
      });
    },
  );

  it("does not turn an interrupted outcome with an end timestamp into registry completion", async () => {
    const key = "agent:main:subagent:interrupted";
    expect(
      await resolveCompletion(key, key, { ...terminalSession, status: "interrupted" }),
    ).toBeNull();
  });

  it.each([
    { name: "default per-agent", file: undefined },
    { name: "configured fixed", file: "sessions.json" },
    { name: "configured custom", file: "custom-sessions.json" },
    { name: "explicit shared SQLite", file: "shared.sqlite" },
  ])("reconciles each agent in a $name store", async ({ file }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      try {
        const storePath = file ? state.path(file) : undefined;
        const cfg: OpenClawConfig = storePath ? { session: { store: storePath } } : {};
        for (const agentId of ["main", "worker"]) {
          for (const sessionKey of [`agent:${agentId}:subagent:child`, "global"]) {
            replaceSessionEntrySync(
              { agentId, sessionKey, storePath, env: state.env },
              { ...terminalSession, sessionId: `${agentId}-child` },
            );
          }
        }

        for (const childAgentId of ["main", "worker"]) {
          for (const childSessionKey of [`agent:${childAgentId}:subagent:child`, "global"]) {
            const target = { childSessionKey, childAgentId, cfg };
            // An explicit shared database has one raw-key namespace; the last global write wins.
            const expectedAgent =
              file === "shared.sqlite" && childSessionKey === "global" ? "worker" : childAgentId;
            expect((await loadSubagentSessionEntry(target))?.sessionId).toBe(
              `${expectedAgent}-child`,
            );
            expect(
              await resolveSubagentSessionCompletion({ ...target, fallbackEndedAt: 3_000 }),
            ).toMatchObject({ endedAt: 2_000, outcome: { status: "ok" } });
            expect(await resolveSubagentSessionStartedAt(target)).toBe(1_000);
          }
        }
        for (const encodedAgent of ["main", "worker"]) {
          const target = {
            childSessionKey: `agent:${encodedAgent}:subagent:child`,
            childAgentId: encodedAgent === "main" ? "worker" : "main",
            cfg,
          };
          expect((await loadSubagentSessionEntry(target))?.sessionId).toBe(`${encodedAgent}-child`);
        }
        await expect(
          loadSubagentSessionEntry({
            childSessionKey: "agent::subagent:child",
            childAgentId: "worker",
            cfg,
          }),
        ).rejects.toThrow("Malformed agent session key");
        await expect(async () =>
          loadSubagentSessionEntry({ childSessionKey: "global", cfg }),
        ).rejects.toThrow("Session key does not contain an agent id");
      } finally {
        await closeOpenClawAgentDatabasesAsync(state.root);
      }
    });
  });

  it.each(["main", "worker"])(
    "keeps %s incognito completion separate from its configured durable store",
    async (agentId) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        try {
          const storePath = state.path("custom-sessions.json");
          const cfg = { session: { store: storePath } } satisfies OpenClawConfig;
          const durableKey = `agent:${agentId}:subagent:durable`;
          const childSessionKey = `agent:${agentId}:subagent:incognito-child`;
          replaceSessionEntrySync(
            { agentId, sessionKey: durableKey, storePath, env: state.env },
            { ...terminalSession, sessionId: "durable-child" },
          );
          replaceSessionEntrySync(
            { agentId, sessionKey: childSessionKey, storePath, env: state.env },
            { ...terminalSession, sessionId: "incognito-child", incognito: true },
          );

          expect(
            await resolveSubagentSessionCompletion({
              childSessionKey,
              cfg,
              fallbackEndedAt: 3_000,
            }),
          ).toMatchObject({ endedAt: 2_000, outcome: { status: "ok" } });
          expect((await loadSubagentSessionEntry({ childSessionKey, cfg }))?.sessionId).toBe(
            "incognito-child",
          );
          expect(
            listSessionEntriesReadOnly({ agentId, storePath, env: state.env }).map(
              ({ sessionKey }) => sessionKey,
            ),
          ).toEqual([durableKey]);
          expect(
            fs.existsSync(resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env })),
          ).toBe(false);
        } finally {
          await closeOpenClawAgentDatabasesAsync(state.root);
        }
      });
    },
  );
});
