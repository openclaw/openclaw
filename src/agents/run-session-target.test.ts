import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withSessionHistoryBudgetSweepsForTest } from "../config/sessions/session-history-budget.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resolveAgentRunSessionTarget as resolveAgentRunSessionTargetImpl } from "./run-session-target.js";

type ResolveTargetParams = Omit<
  Parameters<typeof resolveAgentRunSessionTargetImpl>[0],
  "missingSessionKey"
>;

function resolveAgentRunSessionTarget(
  params: ResolveTargetParams,
  missingSessionKey: "create" | "resolve-existing" = "resolve-existing",
) {
  return resolveAgentRunSessionTargetImpl({ ...params, missingSessionKey });
}

describe("agent run session target", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-run-session-target-");
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "sessions.json");
  });

  function resolveStoredTarget(params: ResolveTargetParams, mode?: "create") {
    return resolveAgentRunSessionTarget(
      { ...params, config: { ...params.config, session: { store: storePath } } },
      mode,
    );
  }

  const expectTarget = (params: ResolveTargetParams, mode?: "create") =>
    expect(resolveStoredTarget(params, mode)).resolves;
  const expectRejected = (params: ResolveTargetParams) =>
    expect(resolveStoredTarget(params)).rejects;
  const partialTarget = (sessionId: string, extra: Partial<ResolveTargetParams> = {}) => ({
    sessionId,
    sessionTarget: { agentId: "main", sessionId },
    ...extra,
  });

  const marker = () =>
    formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: "legacy-session",
      storePath,
    });

  function seed(sessionId: string, sessionKey: string, agentId = "main", updatedAt = 1) {
    return withSessionHistoryBudgetSweepsForTest(() =>
      upsertSessionEntryCore({ agentId, sessionKey, storePath }, { sessionId, updatedAt }),
    );
  }

  function expectKeyedTarget(params: ResolveTargetParams, sessionKey: string, agentId?: string) {
    return expect(resolveStoredTarget(params)).resolves.toMatchObject({
      sessionId: params.sessionId,
      sessionKey,
      storePath,
      ...(agentId ? { agentId } : {}),
    });
  }

  const missingTarget = {
    code: "session-key-missing",
    name: "AgentRunSessionTargetResolutionError",
  };
  const compatTarget = {
    agentId: "main",
    sessionId: "compat-session",
    sessionKey: "agent:main:compat-session",
  };

  it.each([undefined, "compat-session"])(
    "creates the compatibility key with sessionFile=%s",
    async (sessionFile) => {
      await expectTarget({ sessionId: "compat-session", sessionFile }, "create").toEqual({
        ...compatTarget,
        storePath,
      });
    },
  );

  it("resolves an existing keyed row before creating a session-id compatibility key", async () => {
    const sessionId = "2fb701ef-6425-4c48-9b6f-5a170aa2477e";
    const sessionKey = "agent:main:telegram:direct:reporter";
    await seed(sessionId, sessionKey);

    await expectKeyedTarget({ agentId: "main", sessionId }, sessionKey);
  });

  it("keeps detached identity independent of a stored row with the same session id", async () => {
    const sessionId = "detached-session";
    await seed(sessionId, "agent:main:stored");
    const detached = {
      agentId: "main",
      sessionId,
      sessionPersistence: "detached" as const,
    };

    await expectTarget({ ...detached, sessionKey: " Fresh-Key " }).toMatchObject({
      sessionId,
      sessionKey: "agent:main:fresh-key",
    });
    await expectTarget(detached, "create").toMatchObject({
      sessionId,
      sessionKey: "agent:main:detached-session",
    });
    await expectRejected(detached).toMatchObject({
      code: "session-key-missing",
    });
    await expectRejected({ ...detached, sessionKey: "agent:other:detached" }).toThrow(
      'belongs to "other"',
    );
    await expectTarget({ agentId: "main", sessionId }).toMatchObject({
      sessionId,
      sessionKey: "agent:main:stored",
    });
  });

  it.each([
    ["bare fixed owner", "ops", "global", ["ops", "research"], true],
    ["retired fixed owner", "research", "agent:research:work", ["research", "support"], true],
    ["ownerless fleet", "research", "agent:research:work", ["ops", "research"], false],
  ] as const)(
    "resolves the persisted row in a %s",
    async (_name, agentId, sessionKey, agents, fixed) => {
      const sessionId = "persisted-session";
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: Object.fromEntries(agents.map((id) => [id, {}])),
          ...(fixed ? { defaults: { sessionStore: { agentId: "ops" } } } : {}),
        },
      };
      await seed(sessionId, sessionKey, agentId);
      await expectKeyedTarget({ config, sessionId }, sessionKey, agentId);
    },
  );

  it("uses the active runtime store when compatibility projection omits config", async () => {
    const sessionId = "7ef14ab2-4801-40e1-9c56-83f9250c1706";
    const sessionKey = "agent:main:discord:direct:reporter";
    await seed(sessionId, sessionKey);
    setRuntimeConfigSnapshot({ session: { store: storePath } });
    try {
      await expect(
        resolveAgentRunSessionTarget({ agentId: "main", sessionId }),
      ).resolves.toMatchObject({ sessionId, sessionKey, storePath });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it.each([
    { agentId: "main" },
    { config: { agents: { ownership: "explicit", entries: { ops: {}, research: {} } } } },
  ] satisfies Omit<ResolveTargetParams, "sessionId">[])(
    "returns a typed missing-row failure without creating a key: %j",
    async (scope) => {
      await expectRejected({ ...scope, sessionId: "missing-session" }).toMatchObject(missingTarget);
    },
  );

  it("matches a partial typed target key against its compatibility token", async () => {
    await expectKeyedTarget(
      {
        sessionId: "compat-session",
        sessionFile: "custom-key",
        sessionTarget: { agentId: "main", sessionId: "compat-session", sessionKey: "custom-key" },
      },
      "agent:main:custom-key",
    );
  });

  it("recovers the persisted owner from a legacy SQLite marker", async () => {
    const sessionKey = "agent:main:dashboard:legacy-session";
    await seed("legacy-session", sessionKey);
    await seed("legacy-session", "agent:main:legacy-session", "main", 2);

    for (const suppliedKey of [undefined, sessionKey]) {
      await expectTarget({
        sessionId: "legacy-session",
        sessionKey: suppliedKey,
        sessionFile: marker(),
      }).toMatchObject({ sessionKey: "agent:main:legacy-session", storePath });
    }
  });

  it.each([
    { sessionId: "legacy-session", sessionKey: "agent:worker:legacy-session" },
    { agentId: "worker", sessionId: "legacy-session" },
  ])("rejects a partial typed identity conflicting with its marker: %j", async (sessionTarget) => {
    await expectRejected({
      sessionId: "legacy-session",
      sessionFile: marker(),
      sessionTarget,
    }).toThrow("Legacy SQLite transcript marker conflicts");
  });

  it("rejects a compatibility key from another target agent", async () => {
    await expectRejected(
      partialTarget("compat-session", {
        sessionFile: "agent:helper:compat-session",
      }),
    ).toThrow("Compatibility session key conflicts with the supplied agent identity");
  });

  it("does not let a partial typed target suppress file-backed rejection", async () => {
    await expectRejected(
      partialTarget("legacy-session", {
        sessionFile: path.join(tempDir, "legacy-session.jsonl"),
      }),
    ).toThrow("File-backed transcript targets are unsupported");
  });

  it("ignores a stale legacy marker when a complete typed target is present", async () => {
    const sessionTarget = {
      agentId: "main",
      sessionId: "target-session",
      sessionKey: "agent:main:target-session",
      storePath,
    };
    await expectTarget({
      sessionId: "old-session",
      sessionFile: `sqlite:helper:old-session:${path.join(tempDir, "old.json")}`,
      sessionTarget,
    }).toMatchObject(sessionTarget);
  });
});
