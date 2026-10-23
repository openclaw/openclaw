import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { resolveLegacyAuthProfilesPath as resolveAuthStorePath } from "../../commands/doctor-auth-legacy-paths.js";
import { AuthStorage } from "../../plugin-sdk/agent-sessions.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as agentDb from "../../state/openclaw-agent-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withEnv } from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { withPreparedAuthStorePathForDisplay, resolveAuthStorePathForDisplay } from "./paths.js";
import * as sqliteRead from "./sqlite-read.js";
import { closeAuthProfileReadPool } from "./sqlite.js";

it.each([
  ["shared", false],
  ["missing", false],
  ["missing-row", false],
  ["empty", true],
  ["present", true],
  ["unreadable", true],
  ["relocated", false],
  ["tilde", false],
] as const)("prepares the canonical display source without host SQL (%s)", async (mode, local) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "display";
    const agentDir = mode === "tilde" ? "~fake-openclaw-no-expand" : state.agentDir(agentId);
    const env = { ...state.env, ...(mode === "relocated" ? { OPENCLAW_AGENT_DIR: agentDir } : {}) };
    if (mode === "relocated") {
      withEnv({ OPENCLAW_AGENT_DIR: agentDir }, () => {
        expect(path.dirname(resolveAuthStorePath())).toBe(agentDir);
        expect(resolveAuthStorePathForDisplay()).toBe(path.join(agentDir, "openclaw-agent.sqlite"));
      });
    } else if (mode === "tilde") {
      const resolved = resolveAuthStorePathForDisplay(agentDir);
      expect(resolved).toBe(resolveSharedAuthStorePath());
      expect(resolved.startsWith("~")).toBe(false);
    }
    const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
    if (mode === "missing-row") {
      agentDb.openOpenClawAgentDatabase({ agentId, env: state.env });
    } else if (local) {
      const profiles =
        mode === "empty"
          ? {}
          : {
              "fixture:display": createApiKeyCredential("fixture", "synthetic-display"),
            };
      await state.writeAuthProfiles({ version: 1, profiles }, agentId);
    }
    await agentDb.closeOpenClawAgentDatabasesAsync(state.stateDir);
    closeAuthProfileReadPool();
    if (mode === "unreadable") {
      fs.writeFileSync(databasePath, "not a SQLite database");
    }
    const sql = observeMainThreadSql();
    sql.calibrate();
    try {
      const source = mode === "shared" || mode === "relocated" ? undefined : agentDir;
      const displayPath = await AuthStorage.resolvePathForDisplayAsync(source, env);
      expect(displayPath).toBe(local ? databasePath : resolveSharedAuthStorePath(env));
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    if (mode === "missing") {
      expect(fs.existsSync(databasePath)).toBe(false);
    }
  });
});

it("does not invoke a withdrawn model build after its display worker read", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await state.writeAuthProfiles({ version: 1, profiles: {} });
    await agentDb.closeOpenClawAgentDatabasesAsync(state.stateDir);
    closeAuthProfileReadPool();
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const original = sqliteRead.prepareAgentAuthProfileRowsRead;
    const held = vi
      .spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead")
      .mockImplementation((options) => {
        const reader = original(options);
        return {
          ...reader,
          async read() {
            const rows = await reader.read();
            entered.resolve();
            await resume.promise;
            return rows;
          },
        };
      });
    const context = captureOpenClawStateWorkerContext({ env: state.env });
    const withdrawn = new Error("Model build authority was withdrawn");
    let current = true;
    const consume = vi.fn((pathname: string) => pathname);
    const reading = withPreparedAuthStorePathForDisplay(
      state.agentDir(),
      state.env,
      () => {
        context.admission.assertCurrent();
        if (!current) {
          throw withdrawn;
        }
      },
      consume,
    );
    const rejected = expect(reading).rejects.toBe(withdrawn);
    try {
      await awaitGateBeforeSettlement(entered.promise, rejected, "Read gate bypassed");
      current = false;
      resume.resolve();
      await rejected;
      expect(consume).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await reading.catch(() => {});
      held.mockRestore();
    }
  });
});
