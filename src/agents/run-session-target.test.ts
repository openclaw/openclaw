import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withSessionHistoryBudgetSweepsForTest } from "../config/sessions/session-history-budget.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resolveAgentRunSessionTarget as resolveAgentRunSessionTargetImpl } from "./run-session-target.js";

function seedSessionEntry(...args: Parameters<typeof upsertSessionEntryCore>) {
  return withSessionHistoryBudgetSweepsForTest(() => upsertSessionEntryCore(...args));
}

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

  function marker() {
    return formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: "legacy-session",
      storePath,
    });
  }

  function seed(sessionId: string, sessionKey: string, agentId = "main", updatedAt = 1) {
    return seedSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt });
  }

  function expectKeyedTarget(params: ResolveTargetParams, sessionKey: string, agentId?: string) {
    return expect(resolveStoredTarget(params)).resolves.toMatchObject({
      sessionId: params.sessionId,
      sessionKey,
      storePath,
      ...(agentId ? { agentId } : {}),
    });
  }

  function fixedOwnerConfig(
    entries: NonNullable<OpenClawConfig["agents"]>["entries"],
  ): OpenClawConfig {
    return {
      agents: { ownership: "explicit", defaults: { sessionStore: { agentId: "ops" } }, entries },
    };
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

  it("uses the session id as the compatibility key when callers omit sessionKey", async () => {
    await expect(resolveStoredTarget({ sessionId: "compat-session" }, "create")).resolves.toEqual({
      ...compatTarget,
      storePath,
    });
  });

  it("resolves an existing keyed row before creating a session-id compatibility key", async () => {
    const sessionId = "2fb701ef-6425-4c48-9b6f-5a170aa2477e";
    const sessionKey = "agent:main:telegram:direct:reporter";
    await seed(sessionId, sessionKey);

    await expectKeyedTarget({ agentId: "main", sessionId }, sessionKey);
  });

  it("resolves an existing bare row through its persisted fixed-store owner", async () => {
    const sessionId = "fixed-owner-session";
    await seed(sessionId, "global", "ops");

    await expectKeyedTarget(
      { config: fixedOwnerConfig({ ops: {}, research: {} }), sessionId },
      "global",
      "ops",
    );
  });

  it("keeps a scoped live row available when the fixed-store owner is retired", async () => {
    const sessionId = "research-session";
    const sessionKey = "agent:research:work";
    await seed(sessionId, sessionKey, "research");

    await expectKeyedTarget(
      { config: fixedOwnerConfig({ research: {}, support: {} }), sessionId },
      sessionKey,
      "research",
    );
  });

  it("finds an agent-scoped row by id in an ownerless explicit fleet", async () => {
    const storePath = path.join(tempDir, "ownerless", "sessions.json");
    const sessionId = "research-session";
    const sessionKey = "agent:research:work";
    await seedSessionEntry(
      { agentId: "research", sessionKey, storePath },
      { sessionId, updatedAt: 1 },
    );

    await expect(
      resolveAgentRunSessionTarget({
        config: {
          session: { store: storePath },
          agents: {
            ownership: "explicit",
            entries: { ops: {}, research: {} },
          },
        },
        sessionId,
      }),
    ).resolves.toMatchObject({ agentId: "research", sessionId, sessionKey, storePath });
  });

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

  it("returns a typed failure when existing-transcript resolution has no keyed row", async () => {
    await expect(
      resolveStoredTarget({ agentId: "main", sessionId: "missing-session" }),
    ).rejects.toMatchObject(missingTarget);
  });

  it("does not create a key for an unknown session id during cross-agent lookup", async () => {
    await expect(
      resolveStoredTarget({
        config: {
          agents: {
            ownership: "explicit",
            entries: { ops: {}, research: {} },
          },
        },
        sessionId: "unknown-cross-agent-session",
      }),
    ).rejects.toMatchObject(missingTarget);
  });

  it("round-trips a plain compatibility key through sessionFile", async () => {
    await expect(
      resolveStoredTarget({ sessionId: "compat-session", sessionFile: "compat-session" }, "create"),
    ).resolves.toEqual({ ...compatTarget, storePath });
  });

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

    await expect(
      resolveStoredTarget({
        sessionId: "legacy-session",
        sessionFile: marker(),
      }),
    ).resolves.toMatchObject({ sessionKey: "agent:main:legacy-session", storePath });

    await expect(
      resolveStoredTarget({
        sessionId: "legacy-session",
        sessionKey,
        sessionFile: marker(),
      }),
    ).resolves.toMatchObject({ sessionKey: "agent:main:legacy-session", storePath });
  });

  it("rejects a partial typed key from another marker agent", async () => {
    await expect(
      resolveAgentRunSessionTarget({
        config: {},
        sessionId: "legacy-session",
        sessionFile: marker(),
        sessionTarget: {
          sessionId: "legacy-session",
          sessionKey: "agent:worker:legacy-session",
        },
      }),
    ).rejects.toThrow("Legacy SQLite transcript marker conflicts");
  });

  it("rejects a compatibility key from another target agent", async () => {
    await expect(
      resolveAgentRunSessionTarget({
        config: {},
        sessionId: "compat-session",
        sessionFile: "agent:helper:compat-session",
        sessionTarget: { agentId: "main", sessionId: "compat-session" },
      }),
    ).rejects.toThrow("Compatibility session key conflicts with the supplied agent identity");
  });

  it("does not let a partial typed target suppress file-backed rejection", async () => {
    await expect(
      resolveAgentRunSessionTarget({
        config: {},
        sessionId: "legacy-session",
        sessionFile: path.join(tempDir, "legacy-session.jsonl"),
        sessionTarget: { agentId: "main", sessionId: "legacy-session" },
      }),
    ).rejects.toThrow("File-backed transcript targets are unsupported");
  });

  it("rejects a partial typed target that conflicts with a legacy marker", async () => {
    await expect(
      resolveAgentRunSessionTarget({
        config: {},
        sessionId: "legacy-session",
        sessionFile: marker(),
        sessionTarget: { agentId: "worker", sessionId: "legacy-session" },
      }),
    ).rejects.toThrow("Legacy SQLite transcript marker conflicts");
  });

  it("ignores a stale legacy marker when a complete typed target is present", async () => {
    await expect(
      resolveAgentRunSessionTarget({
        config: {},
        sessionId: "old-session",
        sessionFile: `sqlite:helper:old-session:${path.join(tempDir, "old.json")}`,
        sessionTarget: {
          agentId: "main",
          sessionId: "target-session",
          sessionKey: "agent:main:target-session",
          storePath,
        },
      }),
    ).resolves.toMatchObject({
      agentId: "main",
      sessionId: "target-session",
      sessionKey: "agent:main:target-session",
      storePath,
    });
  });
});
