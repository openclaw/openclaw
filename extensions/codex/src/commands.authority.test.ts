import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createClientHarness } from "./app-server/test-support.js";
import type { CodexControlRequestOptions } from "./command-rpc.js";
import {
  createCodexRuntimeContextOverrides,
  runCommand,
  writeTestBinding,
  useCodexCommandTestState,
} from "./commands.test-support.js";
import {
  steerCodexConversationTurn as steerCodexConversationTurnImpl,
  stopCodexConversationTurn as stopCodexConversationTurnImpl,
  trackCodexConversationActiveTurn,
} from "./conversation-control.js";

const requireRecord = createRequireRecord("object", "expected-label");

describe("Codex command authority", () => {
  let tempDir: string;
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      tempDir = stateDir;
    },
  });

  async function boundRuntime(sessionKey: string, model?: string) {
    const runtime = await createCodexRuntimeContextOverrides(tempDir, sessionKey);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: runtime.sessionKey,
    };
    await writeTestBinding(identity, { threadId: "thread-control", cwd: "/repo", model });
    return { runtime, identity };
  }

  it.each([
    { command: "stop", revokeOwner: false },
    { command: "steer", revokeOwner: true },
  ] as const)(
    "rejects queued $command before any write after authority changes (owner: $revokeOwner)",
    async ({ command, revokeOwner }) => {
      const { runtime, identity } = await boundRuntime(`agent:main:test:queued-${command}`);
      let ownerCurrent = true;
      const context = {
        ...runtime,
        assertOwnerCurrent: () => {
          if (!ownerCurrent) {
            throw new Error("Command owner was revoked");
          }
        },
      };
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
        threadId: "thread-control",
        turnId: "turn-1",
      });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const queued =
        <P, R>(operation: (params: P) => Promise<R>) =>
        async (params: P) => {
          entered.resolve();
          await release.promise;
          return await operation(params);
        };

      try {
        const pending = runCommand(
          command === "stop" ? "stop" : "steer keep the authority boundary",
          {
            stopCodexConversationTurn: queued(stopCodexConversationTurnImpl),
            steerCodexConversationTurn: queued(steerCodexConversationTurnImpl),
          },
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
    const { runtime } = await boundRuntime("agent:main:test:read-only-controls", "gpt-5.5");
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
