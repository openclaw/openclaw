import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { getAgentToolAssistantTurnId } from "../../packages/agent-core/src/tool-execution-context.js";
import { createCodeModeJournalStore } from "../config/sessions/code-mode-journal.js";
import type { CodeModeJournalStart } from "../config/sessions/code-mode-journal.types.js";
import type { QueuedOperatorRecoverySource } from "../gateway/operator-run-recovery-source.codec.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "./admitted-run-context.js";
import { markCodeModeControlTool } from "./code-mode-control-tools.js";
import { readCodeModeDurableRecovery } from "./code-mode-durable-context.js";
import {
  captureCodeModeDurableSource,
  readCodeModeDurableRecoverySource,
  recordCodeModeRecoveryAdmission,
  recoverCodeModeDurableExecutions,
} from "./code-mode-durable-recovery.js";
import { sessionManagerReleaseTranscript } from "./sessions/session-manager-core.js";
import { withSessionState } from "./sessions/session-manager-fixtures.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import type { AnyAgentTool } from "./tools/common.js";

const source: QueuedOperatorRecoverySource = {
  kind: "gateway",
  snapshot: {
    profileId: "original-participant",
    scopes: ["operator.write"],
    assignedRole: null,
    githubLogin: null,
    grant: null,
    aliasBindingIds: [],
    authPolicy: {
      generation: "",
      grantGeneration: "fixture-generation",
      role: "operator",
      authMethod: "token",
    },
    controlUiAdmin: false,
    localOperator: false,
    sourceIngress: "control-ui",
  },
};
const result = {
  content: [{ type: "text" as const, text: "original program completed" }],
  details: { exact: [1, "é"] },
};
const signal = () => new AbortController().signal;

it("captures the admitted source ceiling and refuses a revoked source instead of using attribution", () => {
  let current = true;
  if (source.kind !== "gateway") {
    throw new Error("fixture source");
  }
  const authority = createAdmittedRunOperatorAuthority({
    profileId: source.snapshot.profileId,
    recoverySnapshot: source.snapshot,
    scopes: source.snapshot.scopes,
    assertCurrent: () => {
      if (!current) {
        throw new Error("source revoked");
      }
    },
  });
  const prepared = prepareSystemAgentRunAdmission(
    {},
    "durable-source",
    "main",
    "test",
    undefined,
    authority,
  );
  try {
    expect(captureCodeModeDurableSource({ preparedRunAdmission: prepared })).toEqual(source);
    recordCodeModeRecoveryAdmission(authority, source);
    expect(captureCodeModeDurableSource({ preparedRunAdmission: prepared })).toEqual(source);
    current = false;
    expect(() => captureCodeModeDurableSource({ preparedRunAdmission: prepared })).toThrow(
      "source revoked",
    );
    expect(captureCodeModeDurableSource({})).toEqual({ kind: "unavailable", reason: "no-source" });
  } finally {
    prepared.close();
  }
});

it("recovers only the marked exec with original identity and retires its journal with the real append", async () => {
  await withSessionState("durable-recovery", async ({ state, scope }) => {
    const target = { ...scope, assertCurrent: () => {} };
    const store = createCodeModeJournalStore(target);
    const start: CodeModeJournalStart = {
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      executionId: "original-cell",
      version: 1,
      runId: "original-run",
      toolCallId: "original-outer-exec",
      source: { version: 1, sourceJson: JSON.stringify(source) },
      programJson: JSON.stringify({
        code: "return 42;",
        assistantTurnId: "original-assistant",
        deterministic: {},
        workerCatalog: {},
      }),
    };
    await store.begin(start);
    expect(await readCodeModeDurableRecoverySource(target)).toEqual(source);
    const manager = await SessionManager.openAsync(scope, state.root);
    await manager.appendMessageAsync(
      makeAgentAssistantMessage({
        turnId: "original-assistant",
        content: [
          {
            type: "toolCall",
            id: start.toolCallId,
            name: "exec",
            arguments: { code: "return 42;" },
          },
        ],
      }),
    );
    const shell = vi.fn(async () => result);
    const execute = vi.fn(async (id: string, args: unknown) => {
      expect(id).toBe(start.toolCallId);
      expect(getAgentToolAssistantTurnId()).toBe("original-assistant");
      expect(args).toEqual({ code: "return 42;", awaitResults: true });
      expect(readCodeModeDurableRecovery()).toMatchObject(start);
      await store.finish(start.executionId, {
        resultJson: JSON.stringify(result),
        storeJson: "[]",
      });
      return result;
    });
    const plain: AnyAgentTool = {
      name: "exec",
      label: "shell",
      description: "shell",
      parameters: Type.Object({}),
      execute: shell,
    };
    const marked = markCodeModeControlTool({ ...plain, execute });
    try {
      await recoverCodeModeDurableExecutions({
        target,
        source,
        tools: [plain, marked],
        sessionManager: manager,
        signal: signal(),
      });
      expect(shell).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await store.read(start.executionId)).toBeUndefined();
      expect(
        manager
          .getBranch()
          .flatMap((entry) =>
            entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
          ),
      ).toEqual([
        {
          role: "toolResult",
          toolName: "exec",
          toolCallId: start.toolCallId,
          ...result,
          isError: false,
          timestamp: expect.any(Number),
        },
      ]);
      await recoverCodeModeDurableExecutions({
        target,
        source,
        tools: [marked],
        sessionManager: manager,
        signal: signal(),
      });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      manager[sessionManagerReleaseTranscript]();
    }
  });
});

it("reuses a committed outcome without executing, and preserves unfinished evidence on refusal", async () => {
  await withSessionState("durable-refusal", async ({ state, scope }) => {
    let current = true;
    const target = {
      ...scope,
      assertCurrent: () => {
        if (!current) {
          throw new Error("source revoked");
        }
      },
    };
    const store = createCodeModeJournalStore(target);
    const start: CodeModeJournalStart = {
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      executionId: "refused-cell",
      version: 1,
      runId: "original-run",
      toolCallId: "original-outer-exec",
      source: { version: 1, sourceJson: JSON.stringify(source) },
      programJson: '{"code":"return 42;"}',
    };
    await store.begin(start);
    const manager = await SessionManager.openAsync(scope, state.root);
    const execute = vi.fn(async () => result);
    const tool: AnyAgentTool = {
      name: "exec",
      label: "shell",
      description: "not code mode",
      parameters: Type.Object({}),
      execute,
    };
    const recover = (captured: QueuedOperatorRecoverySource = source) =>
      recoverCodeModeDurableExecutions({
        target,
        source: captured,
        tools: [tool],
        sessionManager: manager,
        signal: signal(),
      });
    try {
      await expect(recover({ kind: "unavailable", reason: "no-source" })).rejects.toThrow(
        "original admitted request source",
      );
      await expect(recover()).rejects.toThrow("exec tool is unavailable");
      current = false;
      await expect(recover()).rejects.toThrow("source revoked");
      current = true;
      expect(await store.read(start.executionId)).toMatchObject(start);
      expect(execute).not.toHaveBeenCalled();
      expect(manager.getBranch()).toHaveLength(0);
      await store.finish(start.executionId, {
        resultJson: JSON.stringify(result),
        storeJson: "[]",
      });
      await recover();
      expect(execute).not.toHaveBeenCalled();
      expect(await store.read(start.executionId)).toBeUndefined();
    } finally {
      manager[sessionManagerReleaseTranscript]();
    }
  });
});
