import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import {
  appendTranscriptMessage,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../../../config/sessions/session-actor-storage-binding.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { deliverAgentHarnessCompletion } from "../../../plugin-sdk/agent-harness-completion.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
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

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory announcement opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory announcement allocated a database worker");
  }),
}));

const authority = { assertCurrent() {}, authorize() {} };
type MemoryOwner = ReturnType<typeof memorySessionActorOwners.get>;
let actor: MemoryOwner;
let childActor: MemoryOwner;
const actorEnv = { OPENCLAW_STATE_DIR: "/synthetic/announce" };

async function create(owner: MemoryOwner, input: { sessionKey: string; entry: SessionEntry }) {
  const acquired = await owner.acquire(
    { database: owner.identity, sessionKey: input.sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  try {
    const result = await acquired.storage!.mutate(
      { type: "session.entry.create", input: { entry: input.entry } },
      authority,
    );
    expect(result.kind).toBe("committed");
    return { entry: acquired.snapshot(authority)?.entry };
  } finally {
    await acquired.release();
  }
}

async function withMemorySource<T>(
  owner: MemoryOwner,
  run: () => Promise<T>,
  signal?: AbortSignal,
) {
  const assertCurrent = () => signal?.throwIfAborted();
  const acquired = await owner.acquireExisting(
    `agent:${owner.agentId}:dashboard:incognito-source`,
    {
      assertCurrent,
      assertReadable: assertCurrent,
    },
  );
  assert(acquired);
  try {
    return await runWithSessionActorStorage(
      {
        actor: acquired,
        authority: { assertCurrent, authorize() {} },
        agentId: owner.agentId,
        path: owner.path,
      },
      run,
    );
  } finally {
    await acquired.release();
  }
}

beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", actorEnv.OPENCLAW_STATE_DIR);
  actor = memorySessionActorOwners.get({
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: actorEnv }),
  });
  childActor = memorySessionActorOwners.get({
    agentId: "child",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "child", env: actorEnv }),
  });
  for (const owner of [actor, childActor]) {
    await create(owner, {
      sessionKey: `agent:${owner.agentId}:dashboard:incognito-source`,
      entry: { sessionId: "source", updatedAt: 1, incognito: true },
    });
  }
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetGatewayWorkAdmission();
  memorySessionActorOwners.reset();
  vi.unstubAllEnvs();
});

describe("selected incognito announcement requester", () => {
  it("refuses a requester reset while active-wake injection is prepared", async () => {
    const sessionKey = "agent:main:dashboard:incognito-wake-reset";
    const sessionId = "wake-reset";
    setRuntimeConfigSnapshot({ session: { store: actor.path } });
    await create(actor, {
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
    const pending = withMemorySource(actor, () =>
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
      await patchSessionEntryCore({ agentId: "main", storePath: actor.path, sessionKey }, () => ({
        lifecycleRevision: "replacement",
      }));
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
    await create(actor, {
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
        withMemorySource(actor, () =>
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

  it.each(["requester-closed", "source-revoked"] as const)(
    "retains cross-agent custody until %s",
    async (ending) => {
      const sessionKey = `agent:child:dashboard:incognito-custody-${ending}`;
      setRuntimeConfigSnapshot({
        session: {
          store: `${actorEnv.OPENCLAW_STATE_DIR}/agents/{agentId}/sessions/sessions.json`,
        },
      });
      await create(childActor, {
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
          withMemorySource(
            actor,
            () =>
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
            admission.signal,
          ),
        );
        expect(custody).toBeDefined();
        root.release();
        callerCurrent = false;
        expect(
          (
            await runWithAgentHarnessCompletionCustody(custody!, scope, () =>
              loadRequesterSessionEntry(sessionKey, "child"),
            )
          ).entry?.sessionId,
        ).toBe("custody");
        if (ending === "requester-closed") {
          childActor.closeSession(sessionKey);
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
      expect(failures.size).toBe(0);
    },
  );

  it("reads an exact child result under its recorded actor before returning to the requester", async () => {
    const sessionKey = "agent:child:dashboard:incognito-result";
    const runId = "child-result-run";
    setRuntimeConfigSnapshot({
      session: { store: `${actorEnv.OPENCLAW_STATE_DIR}/agents/{agentId}/sessions/sessions.json` },
    });
    const created = await create(childActor, {
      sessionKey,
      entry: {
        sessionId: "child-result",
        updatedAt: 1,
        lifecycleRevision: "child-result-initial",
        incognito: true,
      },
    });
    assert(created.entry);
    await withMemorySource(childActor, () =>
      appendTranscriptMessage(
        {
          agentId: "child",
          storePath: childActor.path,
          sessionKey,
          sessionId: created.entry!.sessionId,
        },
        {
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Complete private result" }],
            __openclaw: { runId },
          },
        },
      ),
    );
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
    const result = await withMemorySource(actor, () =>
      readSubagentRunAnnounceResult(child, () => child),
    );
    expect(result.text).toBe("Complete private result");
    expect(result.isCurrent()).toBe(true);
  });

  it("reads child usage from the selected actor and keeps fresh absence noncreating", async () => {
    const sessionKey = "agent:main:dashboard:incognito-stats";
    setRuntimeConfigSnapshot({ session: { store: actor.path } });
    await create(actor, {
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
      withMemorySource(actor, () =>
        buildCompactAnnounceStatsLine({ sessionKey, startedAt: 1, endedAt: 1001 }),
      ),
    ).resolves.toBe("Stats: runtime 1s • tokens 30 (in 23 / out 7)");
    const env = { OPENCLAW_STATE_DIR: "/synthetic/announce-absent" };
    const absentPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    setRuntimeConfigSnapshot({ session: { store: absentPath } });
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    const absent = await loadRequesterSessionEntry("agent:main:dashboard:incognito-absent", "main");
    expect(absent.entry).toBeUndefined();
    const scope = createAgentHarnessCompletionScope({
      requesterSessionKey: "agent:main:dashboard:incognito-absent",
    });
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
    expect(memorySessionActorOwners.read({ agentId: "main", path: absentPath })).toBeUndefined();
  });
});

it("reads an unbound incognito announcement from its memory owner", async () => {
  const agentId = "unbound-announcer";
  const sessionKey = `agent:${agentId}:dashboard:incognito-unbound`;
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: actorEnv });
  setRuntimeConfigSnapshot({ session: { store: storePath } });
  await replaceSessionEntry(
    { agentId, sessionKey, storePath, env: actorEnv },
    { sessionId: "unbound-announcement", updatedAt: 1, incognito: true },
  );
  expect((await loadRequesterSessionEntry(sessionKey, agentId)).entry?.sessionId).toBe(
    "unbound-announcement",
  );
  expect(
    memorySessionActorOwners.read({ agentId, path: storePath })?.readSession(sessionKey, authority)
      ?.entry?.sessionId,
  ).toBe("unbound-announcement");
});
