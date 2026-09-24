import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearSessionStoreCacheForTest,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCodexTestBindingStore } from "./app-server/session-binding.test-helpers.js";
import { resetSharedCodexAppServerClientForTests } from "./app-server/shared-client.js";
import { createClientHarness } from "./app-server/test-support.js";
import { codexDiagnosticsFeedbackState } from "./command-diagnostics-state.js";
import type { CodexControlRequestOptions } from "./command-rpc.js";
import {
  createCodexRuntimeContextOverrides,
  runCommand,
  writeTestBinding,
} from "./commands.test-support.js";
import {
  steerCodexConversationTurn as steerCodexConversationTurnImpl,
  stopCodexConversationTurn as stopCodexConversationTurnImpl,
  trackCodexConversationActiveTurn,
} from "./conversation-control.js";

const requireRecord = createRequireRecord("object", "expected-label");

describe("Codex command authority", () => {
  let tempDir: string;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      codexDiagnosticsFeedbackState.clear();
      resetSharedCodexAppServerClientForTests();
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      clearRuntimeAuthProfileStoreSnapshots();
      clearSessionStoreCacheForTest();
      vi.unstubAllEnvs();
      cleanup();
    }),
  );

  beforeEach(() => {
    resetCodexTestBindingStore();
    tempDir = tempDirs.make("openclaw-codex-command-");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
  });

  it.each([
    { command: "stop", revokeOwner: false },
    { command: "steer", revokeOwner: false },
    { command: "stop", revokeOwner: true },
    { command: "steer", revokeOwner: true },
  ] as const)(
    "rejects queued $command before any write after authority changes (owner: $revokeOwner)",
    async ({ command, revokeOwner }) => {
      const runtime = await createCodexRuntimeContextOverrides(
        tempDir,
        `agent:main:test:queued-${command}`,
      );
      let ownerCurrent = true;
      const context = {
        ...runtime,
        assertOwnerCurrent: () => {
          if (!ownerCurrent) {
            throw new Error("Command owner was revoked");
          }
        },
      };
      const identity = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "session-1",
        sessionKey: runtime.sessionKey,
      };
      await writeTestBinding(identity, {
        threadId: `thread-queued-${command}`,
        cwd: "/repo",
      });
      const harness = createClientHarness({
        onWrite: (line, send) => {
          const request = requireRecord(JSON.parse(line), "Codex request");
          send({ id: request.id, result: {} });
        },
      });
      const stopTracking = trackCodexConversationActiveTurn({
        identity,
        client: harness.client,
        requestTimeoutMs: 60_000,
        threadId: `thread-queued-${command}`,
        turnId: "turn-1",
      });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const stop = vi.fn(async (params: Parameters<typeof stopCodexConversationTurnImpl>[0]) => {
        entered.resolve();
        await release.promise;
        return await stopCodexConversationTurnImpl(params);
      });
      const steer = vi.fn(async (params: Parameters<typeof steerCodexConversationTurnImpl>[0]) => {
        entered.resolve();
        await release.promise;
        return await steerCodexConversationTurnImpl(params);
      });

      try {
        const pending =
          command === "stop"
            ? runCommand("stop", { stopCodexConversationTurn: stop }, context)
            : runCommand(
                "steer keep the authority boundary",
                { steerCodexConversationTurn: steer },
                context,
              );
        await entered.promise;
        if (revokeOwner) {
          ownerCurrent = false;
        } else {
          await upsertSessionEntry({
            storePath: runtime.sessionTarget.storePath,
            sessionKey: runtime.sessionKey,
            entry: {
              sessionId: "session-next",
              previousSessionId: "session-1",
              updatedAt: Date.now(),
              agentHarnessId: "codex",
            },
          });
        }
        release.resolve();

        expect((await pending).text).toContain(
          revokeOwner
            ? "Command owner was revoked"
            : "Codex session generation is no longer current",
        );
        expect(harness.writes).toHaveLength(0);
      } finally {
        release.resolve();
        stopTracking();
        harness.client.close();
      }
    },
  );

  it("does not require owner authority for current-session control status reads", async () => {
    const runtime = await createCodexRuntimeContextOverrides(
      tempDir,
      "agent:main:test:read-only-controls",
    );
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: runtime.sessionKey,
      },
      { threadId: "thread-status", cwd: "/repo", model: "gpt-5.5" },
    );
    const context = {
      ...runtime,
      senderIsOwner: false,
      assertOwnerCurrent: () => {
        throw new Error("Caller is not a channel owner");
      },
    };
    const codexControlRequest = vi.fn(
      async (
        _pluginConfig: unknown,
        _method: string,
        _params: unknown,
        options?: CodexControlRequestOptions,
      ) => {
        options?.assertCurrent?.();
        options?.assertOwnerCurrent?.();
        return { goal: null };
      },
    );
    for (const [command, expected] of [
      ["model", "Codex model: gpt-5.5"],
      ["fast status", "Codex fast mode: off."],
      ["permissions status", "Codex permissions: default."],
      ["goal status", "No Codex goal is active."],
    ] as const) {
      const result = await runCommand(command, { codexControlRequest }, context);
      expect(result.text).toBe(expected);
    }
    expect(codexControlRequest).toHaveBeenCalledOnce();
  });
});
