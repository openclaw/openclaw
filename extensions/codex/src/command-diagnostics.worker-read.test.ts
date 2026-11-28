import path from "node:path";
import { saveAuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { updateAuthProfileStoreWithLock } from "openclaw/plugin-sdk/provider-auth";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import * as sharedClientRuntime from "./app-server/shared-client.js";
import { createClientHarness } from "./app-server/test-support.js";
import { handleCodexDiagnosticsFeedback } from "./command-diagnostics.js";
import { createCodexCommandHost } from "./command-host.test-support.js";
import {
  createContext,
  useCodexCommandTestState,
  writeTestBinding,
} from "./commands.test-support.js";

const requireRecord = createRequireRecord("object", "expected-label");

describe("Codex diagnostics credential disclosure", () => {
  let diagnosticsStateDir: string;
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      diagnosticsStateDir = stateDir;
    },
  });

  it.each([false, true])(
    "checks the implicit account off-thread at diagnostics dispatch (revoked: %s)",
    async (revoke) => {
      const agentDir = path.join(diagnosticsStateDir, "agents/main/agent");
      const profileId = "openai:diagnostics-fixture";
      const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
      saveAuthProfileStore({ version: 1, profiles: {} }, undefined, saveOptions);
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "token",
              provider: "openai",
              token: "synthetic-diagnostics-token",
            },
          },
        },
        agentDir,
        saveOptions,
      );
      const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
      await writeTestBinding(identity, {
        threadId: "thread-auth-diagnostics",
        cwd: diagnosticsStateDir,
      });
      const harness = createClientHarness({
        onWrite(line, send) {
          const request = requireRecord(JSON.parse(line), "diagnostics request");
          send({ id: request.id, result: { threadId: "thread-auth-diagnostics" } });
        },
      });
      const entered = createDeferred<void>();
      const resume = createDeferred<void>();
      const acquire = vi
        .spyOn(sharedClientRuntime, "getLeasedSharedCodexAppServerClient")
        .mockImplementation(async () => {
          entered.resolve();
          await resume.promise;
          return harness.client;
        });
      const pending = handleCodexDiagnosticsFeedback(
        createCodexCommandHost(),
        createContext("diagnostics", undefined, {
          diagnosticsUploadApproved: true,
          config: { agents: { entries: { main: { agentDir } } }, plugins: { enabled: false } },
        }),
        undefined,
        "synthetic note",
      );
      let sql: ReturnType<typeof observeHostDataSql> | undefined;
      try {
        await Promise.race([
          entered.promise,
          pending.then((result) => {
            throw new Error(`Diagnostics ended before dispatch: ${result.text}`);
          }),
        ]);
        if (revoke) {
          const updated = await updateAuthProfileStoreWithLock({
            agentDir,
            saveOptions,
            updater(store) {
              delete store.profiles[profileId];
              return true;
            },
          });
          expect(updated).not.toBeNull();
        }
        sql = observeHostDataSql();
        resume.resolve();
        const result = await pending;
        expect(harness.writes).toHaveLength(revoke ? 0 : 1);
        expect(result.text).toContain(
          revoke ? "Could not send Codex diagnostics" : "Codex diagnostics sent to OpenAI servers:",
        );
        expect(sql.queries).toEqual([]);
      } finally {
        sql?.restore();
        resume.resolve();
        await pending.catch(() => {});
        acquire.mockRestore();
        harness.client.close();
      }
    },
  );
});
