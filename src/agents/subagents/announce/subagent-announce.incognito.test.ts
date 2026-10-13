import "../../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { withIncognitoSessionBinding } from "../../../config/sessions/session-incognito-binding.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { deliverAgentHarnessCompletion } from "../../../plugin-sdk/agent-harness-completion.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import {
  openIncognitoTestActor,
  useIncognitoNoHostSql,
} from "../../../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../../../state/openclaw-agent-execution.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  captureAgentHarnessCompletionCustody,
  runWithAgentHarnessCompletionCustody,
  type AgentHarnessCompletionCustody,
} from "../../agent-harness-completion-custody.js";
import { createAgentHarnessCompletionScope } from "../../agent-harness-completion-scope.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { maybeSteerSubagentAnnounce } from "./subagent-announce-active-wake.js";
import { loadRequesterSessionEntry } from "./subagent-announce-delivery.runtime.js";
import {
  buildCompactAnnounceStatsLine,
  readSubagentRunAnnounceResult,
} from "./subagent-announce-output.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
let childActor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
let actorEnv: NodeJS.ProcessEnv;
beforeAll(async () => {
  actorEnv = { OPENCLAW_STATE_DIR: tempDirs.make("announce-incognito-") };
  actor = await openIncognitoTestActor(actorEnv, authority);
  childActor = await openIncognitoTestActor(actorEnv, authority, "child");
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetGatewayWorkAdmission();
});
afterAll(async () => {
  await childActor.close();
  await actor.close();
});

describe("selected incognito announcement requester", () => {
  useIncognitoNoHostSql();

  it("refuses a requester reset while active-wake injection is prepared", async () => {
    const sessionKey = "agent:main:dashboard:incognito-wake-reset";
    const sessionId = "wake-reset";
    setRuntimeConfigSnapshot({ session: { store: actor.path } });
    await actor.sessions.create(authority, {
      sessionKey,
      entry: { sessionId, updatedAt: 1, lifecycleRevision: "original", incognito: true },
    });
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const injected: string[] = [];
    const handle = createEmbeddedRunHandle({ supportsTranscriptCommitWait: true });
    handle.messageInjectionV2 = {
      version: 2,
      isAvailable: () => true,
      queueMessage: async (text, _options, assertCurrent) => {
        entered.resolve();
        await resume.promise;
        assertCurrent();
        injected.push(text);
      },
    };
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    const pending = withIncognitoSessionBinding({ actor }, () =>
      maybeSteerSubagentAnnounce({
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        steerMessage: "Child completed",
      }),
    );
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "Wake settled before injection preparation",
      );
      await withIncognitoSessionBinding({ actor }, () =>
        patchSessionEntryCore({ agentId: "main", storePath: actor.path, sessionKey }, () => ({
          lifecycleRevision: "replacement",
        })),
      );
      resume.resolve();
      await expect(pending).resolves.toEqual({ status: "source_owner_changed" });
      expect(injected).toEqual([]);
    } finally {
      resume.resolve();
      await pending;
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    }
  });

  it("does not steer another physical requester's active run with the same key", async () => {
    const sessionKey = "agent:main:dashboard:incognito-wake-collision";
    setRuntimeConfigSnapshot({ session: { store: actor.path } });
    await actor.sessions.create(authority, {
      sessionKey,
      entry: { sessionId: "local-requester", updatedAt: 1, incognito: true },
    });
    const injected: string[] = [];
    const handle = createEmbeddedRunHandle({ supportsTranscriptCommitWait: true });
    handle.messageInjectionV2 = {
      version: 2,
      isAvailable: () => true,
      queueMessage: async (text, _options, assertCurrent) => {
        assertCurrent();
        injected.push(text);
      },
    };
    setActiveEmbeddedRun("foreign-requester", handle, sessionKey);
    try {
      await expect(
        withIncognitoSessionBinding({ actor }, () =>
          maybeSteerSubagentAnnounce({
            requesterSessionKey: sessionKey,
            requesterAgentId: "main",
            steerMessage: "Private completion",
          }),
        ),
      ).resolves.toEqual({ status: "none" });
      expect(injected).toEqual([]);
    } finally {
      clearActiveEmbeddedRun("foreign-requester", handle, sessionKey);
    }
  });

  it.each(["requester-reset", "source-revoked"] as const)(
    "joins retained cross-agent custody settlement after %s",
    async (ending) => {
      const sessionKey = `agent:child:dashboard:incognito-custody-${ending}`;
      setRuntimeConfigSnapshot({
        session: {
          store: `${actorEnv.OPENCLAW_STATE_DIR}/agents/{agentId}/sessions/sessions.json`,
        },
      });
      await childActor.sessions.create(authority, {
        sessionKey,
        entry: {
          sessionId: "custody",
          updatedAt: 1,
          lifecycleRevision: "original",
          incognito: true,
        },
      });
      const context = createContext();
      const failures = new Set<unknown>();
      const work = new AsyncWorkScope(failures);
      context.trackExecution = (run) => work.track(run);
      const admission = new AbortController();
      const resolver = () => context;
      context.resolveGatewayContext = resolver;
      const scope = createAgentHarnessCompletionScope({
        requesterSessionKey: sessionKey,
      });
      const root = tryBeginGatewayRootWorkAdmission("test:incognito-custody")!;
      let custody: AgentHarnessCompletionCustody | undefined;
      let callerCurrent = true;
      try {
        custody = await root.run(() =>
          withIncognitoSessionBinding({ actor, admissionSignal: admission.signal }, () =>
            withGatewayToolCallerIdentity(
              {
                agentId: "child",
                sessionKey,
                operationalRunInstance:
                  createTestAdmittedRunContext("incognito-parent").operationalRunInstance,
                receiptAuthority: () => callerCurrent,
                gatewayContextResolver: resolver,
              },
              () => captureAgentHarnessCompletionCustody(scope),
            ),
          ),
        );
        expect(custody).toBeDefined();
        expect(work.hasPendingWork).toBe(true);
        root.release();
        callerCurrent = false;
        expect(
          (
            await runWithAgentHarnessCompletionCustody(custody!, scope, () =>
              loadRequesterSessionEntry(sessionKey, "child"),
            )
          ).entry?.sessionId,
        ).toBe("custody");
        if (ending === "requester-reset") {
          await withIncognitoSessionBinding({ actor: childActor }, () =>
            patchSessionEntryCore(
              { agentId: "child", storePath: childActor.path, sessionKey },
              () => ({ lifecycleRevision: "replacement" }),
            ),
          );
        } else {
          admission.abort(new Error("source revoked during custody"));
        }
        expect(custody!.isCurrent()).toBe(false);
      } finally {
        custody?.release();
        root.release();
        await work.drain();
      }
      expect(work.hasPendingWork).toBe(false);
      if (ending === "source-revoked") {
        expect([...failures]).toEqual([
          expect.objectContaining({ message: "source revoked during custody" }),
        ]);
      } else {
        expect(failures.size).toBe(0);
      }
    },
  );

  it("reads an exact child result under its recorded actor before returning to the requester", async () => {
    const sessionKey = "agent:child:dashboard:incognito-result";
    const runId = "child-result-run";
    setRuntimeConfigSnapshot({
      session: { store: `${actorEnv.OPENCLAW_STATE_DIR}/agents/{agentId}/sessions/sessions.json` },
    });
    const created = await childActor.sessions.create(authority, {
      sessionKey,
      entry: {
        sessionId: "child-result",
        updatedAt: 1,
        lifecycleRevision: "child-result-initial",
        incognito: true,
      },
    });
    assert(created.entry);
    await childActor.sessions.transcript(authority, {
      type: "session.message.append",
      input: {
        sessionKey,
        sessionId: created.entry.sessionId,
        fence: { expectedLifecycleRevision: created.entry.lifecycleRevision },
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Complete private result" }],
          __openclaw: { runId },
        },
      },
    });
    const child: SubagentRunRecord = {
      runId,
      childSessionKey: sessionKey,
      childAgentId: "child",
      requesterSessionKey: "agent:main:dashboard:incognito-requester",
      requesterDisplayKey: "requester",
      requesterAgentId: "main",
      task: "Return a complete result",
      cleanup: "keep",
      createdAt: 1,
      execution: { status: "terminal", outcome: { status: "ok" } },
      completion: { required: true, terminalReply: { disposition: "visible", text: "Truncated" } },
    };
    const result = await withIncognitoSessionBinding({ actor }, () =>
      readSubagentRunAnnounceResult(child, () => child),
    );
    expect(result.text).toBe("Complete private result");
    expect(result.isCurrent()).toBe(true);
  });

  it("reads child usage from the selected actor and keeps fresh absence noncreating", async () => {
    const sessionKey = "agent:main:dashboard:incognito-stats";
    setRuntimeConfigSnapshot({ session: { store: actor.path } });
    await actor.sessions.create(authority, {
      sessionKey,
      entry: {
        sessionId: "stats",
        updatedAt: 1,
        incognito: true,
        inputTokens: 23,
        outputTokens: 7,
      },
    });
    await expect(
      withIncognitoSessionBinding({ actor }, () =>
        buildCompactAnnounceStatsLine({ sessionKey, startedAt: 1, endedAt: 1001 }),
      ),
    ).resolves.toBe("Stats: runtime 1s • tokens 30 (in 23 / out 7)");
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("announce-absent-") };
    const absent = await withIncognitoSessionBinding(
      { kind: "absent", agentId: "main", env, authority },
      () => loadRequesterSessionEntry("agent:main:dashboard:incognito-absent", "main"),
    );
    expect(absent.entry).toBeUndefined();
    const scope = createAgentHarnessCompletionScope({
      requesterSessionKey: "agent:main:dashboard:incognito-absent",
    });
    await withIncognitoSessionBinding(
      { kind: "absent", agentId: "main", env, authority },
      async () => {
        expect(await captureAgentHarnessCompletionCustody(scope)).toBeUndefined();
        await expect(
          deliverAgentHarnessCompletion({
            scope,
            childSessionKey: "agent:child:subagent:missing",
            childSessionId: "missing",
            announceId: "absent-requester",
            status: "succeeded",
            result: "Completed",
            isSourceSessionAdmissionAllowed: () => true,
          }),
        ).resolves.toMatchObject({ delivered: false, path: "none", recoveryBlocked: true });
      },
    );
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
  });
});

it("keeps unbound incognito announcement reads on their native owner", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("announce-native-") };
  const agentId = "native-announcer";
  const sessionKey = `agent:${agentId}:dashboard:incognito-native`;
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
  setRuntimeConfigSnapshot({ session: { store: storePath } });
  try {
    await replaceSessionEntry(
      { agentId, sessionKey, storePath, env },
      {
        sessionId: "native-announcement",
        updatedAt: 1,
        incognito: true,
      },
    );
    expect((await loadRequesterSessionEntry(sessionKey, agentId)).entry?.sessionId).toBe(
      "native-announcement",
    );
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
  } finally {
    await closeOpenClawAgentDatabaseByPathAsync(storePath, agentId);
  }
});
