import { getSessionEntry, patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it } from "vitest";
import { resolveCodexCommandDeps } from "./command-handler-deps.js";
import { resolvePreparedCodexCommandAuthority } from "./command-handler-scope.js";
import {
  createContext,
  createCodexRuntimeContextOverrides,
  createDeps,
  useCodexCommandTestState,
  writeTestBinding,
} from "./commands.test-support.js";

let tempDir: string;
const sessionIdentity = { kind: "session", agentId: "main", sessionId: "session-1" } as const;

describe("codex command", () => {
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      tempDir = stateDir;
    },
  });

  it("keeps manual command source predicates in worker entry commits", async () => {
    const context = await createCodexRuntimeContextOverrides(tempDir);
    await writeTestBinding(
      { ...sessionIdentity, sessionKey: context.sessionKey },
      { threadId: "thread-manual-source", cwd: tempDir, model: "gpt-5.4" },
    );
    const authority = await resolvePreparedCodexCommandAuthority(
      resolveCodexCommandDeps(createDeps()),
      createContext("model gpt-5.5", undefined, context),
    );
    const sql = observeHostDataSql();
    try {
      await patchSessionEntry({
        ...context.sessionTarget,
        skipMaintenance: true,
        assertCommitAllowed: authority.assertMutationCurrent,
        update: () => ({ modelOverride: "gpt-5.5" }),
      });
    } finally {
      sql.restore();
    }
    expect(
      sql.queries.filter((query) =>
        /\b(?:session_nodes|session_entry_snapshots|session_windows)\b/i.test(query),
      ),
    ).toEqual([]);
    expect(getSessionEntry(context.sessionTarget)?.modelOverride).toBe("gpt-5.5");
  });
});
