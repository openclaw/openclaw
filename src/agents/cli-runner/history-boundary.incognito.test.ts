import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import {
  openIncognitoTestActor,
  useIncognitoActorProbe,
  useIncognitoNoHostSql,
} from "../../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { sessionTranscriptHasContent } from "../command/attempt-execution.helpers.js";
import { resolveSession } from "../command/session.js";
import { SessionManager } from "../sessions/session-manager.js";
import { persistCliRunBlock } from "./cli-run-transcript.js";
import { prepareCliHistoryBoundary } from "./history-boundary.js";
import { hasCliSessionTranscript, loadCliSessionHistoryMessages } from "./session-history.js";
import type { PreparedCliRunContext } from "./types.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
const probe = useIncognitoActorProbe();
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: dirs.make("cli-history-actor-") };
  actor = await openIncognitoTestActor(env, authority);
});
afterAll(async () => {
  await actor?.close();
});
useIncognitoNoHostSql();

async function create(name: string) {
  const target = {
    agentId: "main",
    sessionKey: `agent:main:dashboard:incognito-${name}`,
    sessionId: name,
    storePath: actor.path,
  };
  await actor.sessions.create(authority, {
    sessionKey: target.sessionKey,
    entry: {
      sessionId: name,
      lifecycleRevision: "initial",
      incognito: true,
      updatedAt: Date.now(),
      sessionStartedAt: Date.now(),
      permissionMode: "full",
      thinkingLevel: "high",
    },
  });
  return target;
}

it("prepares private CLI history and refuses an unattributed append at execution", async () => {
  const target = await create("history");
  const admission = prepareSystemAgentRunAdmission({}, "actor-cli-run", "main", "history-test");
  try {
    const params: PreparedCliRunContext["params"] = {
      ...target,
      sessionTarget: target,
      sessionFile: target.sessionKey,
      admittedRunContext: await admission.admit("embedded"),
      runId: "actor-cli-run",
      provider: "test-cli",
      model: "test-model",
      prompt: "current ask",
      workspaceDir: env.OPENCLAW_STATE_DIR!,
      timeoutMs: 1000,
    };
    await withIncognitoSessionActor(actor, async () => {
      const writer = await prepareCliHistoryBoundary(params, {
        credential: { type: "token", provider: "test-cli", token: "synthetic-account" },
      });
      assert(writer);
      await writer.assertReadable();
      await runWithCliHistoryWriter(writer, async () => {
        const manager = await SessionManager.openAsync(target);
        await manager.appendMessageAsync(makeUserMessage("Private CLI context", 1));
        await manager.appendMessageAsync({
          role: "assistant",
          content: [{ type: "text", text: "Private CLI answer" }],
          api: "cli",
          provider: "test-cli",
          model: "test-model",
          stopReason: "stop",
          timestamp: 2,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        });
        await writer.assertReadable();
        expect(await hasCliSessionTranscript({ sessionTarget: target })).toBe(true);
        expect(await loadCliSessionHistoryMessages({ sessionTarget: target })).toMatchObject([
          { role: "user", content: "Private CLI context" },
          { role: "assistant", content: [{ type: "text", text: "Private CLI answer" }] },
        ]);
        expect(await sessionTranscriptHasContent(target)).toBe(true);
      });
      const manager = await SessionManager.openAsync(target);
      await manager.appendMessageAsync(makeUserMessage("Different writer", 3));
      await expect(writer.assertReadable()).rejects.toThrow("CLI history authority changed");
    });
  } finally {
    admission.close();
  }
});

it("resolves exact command overrides and records a blocked CLI turn on the selected actor", async () => {
  const target = await create("command");
  await withIncognitoSessionActor(actor, async () => {
    const cfg = { agents: { defaults: {} }, session: { store: actor.path } };
    const resolved = await resolveSession({ cfg, ...target });
    expect(resolved).toMatchObject({
      sessionId: target.sessionId,
      isNewSession: false,
      persistedThinking: "high",
      sessionEntry: { permissionMode: "full" },
    });
    await persistCliRunBlock(
      {
        ...target,
        config: cfg,
        sessionEntry: resolved.sessionEntry,
        sessionTarget: target,
        sessionFile: target.sessionKey,
        runId: "blocked-cli-run",
        provider: "test-cli",
        prompt: "Private rejected content",
        workspaceDir: env.OPENCLAW_STATE_DIR!,
        timeoutMs: 1000,
      },
      { pluginId: "test-policy", message: "Policy blocked this request" },
    );
    const history = await loadCliSessionHistoryMessages({ sessionTarget: target });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(history)).toContain("Policy blocked this request");
    expect(JSON.stringify(history)).not.toContain("Private rejected content");
  });
});

it("does not accept command preparation after cancellation during an actor read", async () => {
  const target = await create("cancelled-command");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const abort = new AbortController();
  const stop = probe.observe(async (type) => {
    if (type === "session.entry.read") {
      entered.resolve();
      await release.promise;
    }
  });
  const resolving = withIncognitoSessionActor(actor, () =>
    resolveSession({
      cfg: { agents: { defaults: {} }, session: { store: actor.path } },
      ...target,
      signal: abort.signal,
    }),
  );
  const rejected = expect(resolving).rejects.toThrow("command cancelled");
  try {
    await entered.promise;
    abort.abort(new Error("command cancelled"));
    release.resolve();
    await rejected;
  } finally {
    release.resolve();
    stop();
    await Promise.allSettled([resolving]);
  }
});

it("keeps selected absence distinct from a released command actor", async () => {
  const missingEnv = { OPENCLAW_STATE_DIR: dirs.make("cli-absent-actor-") };
  const sessionKey = "agent:main:dashboard:incognito-missing";
  const missingTarget = {
    agentId: "main",
    sessionKey,
    sessionId: "missing",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: missingEnv }),
  };
  await withIncognitoSessionBinding(
    { kind: "absent", agentId: "main", env: missingEnv, authority },
    async () => {
      const resolved = await resolveSession({
        cfg: {
          agents: { defaults: {} },
          session: { store: missingTarget.storePath },
        },
        sessionKey,
      });
      expect(resolved.sessionEntry).toBeUndefined();
      expect(await hasCliSessionTranscript({ sessionTarget: missingTarget })).toBe(false);
      expect(await loadCliSessionHistoryMessages({ sessionTarget: missingTarget })).toEqual([]);
      expect(await sessionTranscriptHasContent(missingTarget)).toBe(false);
      expect(captureOpenClawAgentDatabaseExecution.listIncognito(missingEnv)).toEqual([]);
    },
  );
  const target = await create("rebound-command");
  const borrowed = await openIncognitoTestActor(env, authority);
  await withIncognitoSessionBinding({ actor: borrowed }, async () => {
    const cfg = { agents: { defaults: {} }, session: { store: actor.path } };
    await borrowed.release();
    await expect(resolveSession({ cfg, ...target })).rejects.toThrow("reference is released");
  });
});
