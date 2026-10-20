import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../../../config/sessions/session-actor-storage-binding.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { callGateway as runtimeCallGateway } from "../../../gateway/call.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { deliverAgentHarnessCompletion } from "../../../plugin-sdk/agent-harness-completion.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import type { ReplyBackendMessageInjectionV2 } from "../../../sessions/session-controller.backend-contracts.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  clearSessionControllerMailbox,
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../../sessions/session-controller.operation.js";
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
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { loadRequesterSessionEntry } from "./subagent-announce-delivery.runtime.js";
import { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";
import {
  buildCompactAnnounceStatsLine,
  readSubagentRunAnnounceResult,
} from "./subagent-announce-output.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-overrides.test-support.js";

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
const actorPath = (agentId: string, env = actorEnv) =>
  resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
function memoryOwner(agentId: string) {
  return memorySessionActorOwners.get({ agentId, path: actorPath(agentId) });
}

async function create(
  owner: MemoryOwner,
  sessionKey: string,
  entry: Pick<SessionEntry, "sessionId"> & Partial<SessionEntry>,
) {
  const acquired = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  try {
    const result = await acquired.storage!.mutate(
      {
        type: "session.entry.create",
        input: { entry: { updatedAt: 1, incognito: true, ...entry } },
      },
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

function activeOperation(
  sessionKey: string,
  sessionId: string,
  target: ReturnType<typeof captureSessionTarget>,
  queueMessage: ReplyBackendMessageInjectionV2["queueMessage"],
) {
  const operation = createReplyOperation({
    sessionKey,
    sessionId,
    resetTriggered: false,
    target,
  });
  operation.setPhase("running");
  operation.attachBackend({
    kind: "embedded",
    cancel() {},
    supportsTranscriptCommitWait: true,
    messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
  });
  return operation;
}

beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", actorEnv.OPENCLAW_STATE_DIR);
  actor = memoryOwner("main");
  childActor = memoryOwner("child");
  for (const owner of [actor, childActor]) {
    await create(owner, `agent:${owner.agentId}:dashboard:incognito-source`, {
      sessionId: "source",
    });
  }
});
afterEach(() => {
  setSubagentAnnounceDeliveryDepsForTest();
  clearRuntimeConfigSnapshot();
  resetGatewayWorkAdmission();
  memorySessionActorOwners.reset();
  vi.unstubAllEnvs();
});

describe("selected incognito announcement requester", () => {
  it.each(["closed requester", "foreign requester"] as const)(
    "does not inject into a %s",
    async (scenario) => {
      const closed = scenario === "closed requester";
      const sessionKey = `agent:main:dashboard:incognito-wake-${closed ? "reset" : "collision"}`;
      const sessionId = closed ? "wake-reset" : "local-requester";
      setRuntimeConfigSnapshot({ session: { store: actor.path } });
      await create(actor, sessionKey, {
        sessionId,
        ...(closed ? { lifecycleRevision: "original" } : {}),
      });
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const injected: string[] = [];
      const target = captureSessionTarget({
        storeScope: actor.path,
        sessionKey,
        agentId: "main",
        incarnation: sessionId,
      });
      const operation = activeOperation(
        sessionKey,
        closed ? sessionId : "foreign-requester",
        closed
          ? target
          : captureSessionTarget({
              storeScope: actorPath("main", {
                OPENCLAW_STATE_DIR: "/synthetic/foreign-announcement",
              }),
              sessionKey,
              agentId: "main",
              incarnation: "foreign-requester",
            }),
        async (text, _options, assertCurrent) => {
          if (closed) {
            entered.resolve();
            await resume.promise;
          }
          assertCurrent();
          injected.push(text);
        },
      );
      const input = reserveSessionControllerSource(sessionKey, {
        target,
        policy: { mode: "steer" },
      });
      const callGateway = vi.fn<typeof runtimeCallGateway>().mockResolvedValue({
        status: "ok",
        result: { payloads: [{ text: "Completion accepted by local requester" }] },
      });
      if (!closed) {
        setSubagentAnnounceDeliveryDepsForTest({ callGateway });
      }
      const pending = withMemorySource(actor, () =>
        sendSubagentAnnounceDirectly({
          requesterSessionKey: sessionKey,
          targetRequesterSessionKey: sessionKey,
          requesterAgentId: "main",
          requesterIsSubagent: false,
          triggerMessage: closed ? "Child completed" : "Private completion",
          expectsCompletionMessage: true,
          directIdempotencyKey: closed
            ? "incognito-closed-requester-completion"
            : "incognito-physical-requester-completion",
          controllerInput: input,
        }),
      );
      try {
        if (closed) {
          await awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "Wake settled before injection preparation",
          );
          actor.closeSession(sessionKey);
          resume.resolve();
        }
        await expect(pending).resolves.toMatchObject(
          closed
            ? { delivered: false, reason: "source_owner_changed" }
            : { delivered: true, path: "direct" },
        );
        expect(injected).toEqual([]);
        if (!closed) {
          expect(callGateway).toHaveBeenCalledOnce();
          expect(callGateway).toHaveBeenCalledWith(
            expect.objectContaining({
              method: "agent",
              params: expect.objectContaining({ sessionKey, agentId: "main" }),
            }),
          );
        }
      } finally {
        resume.resolve();
        try {
          await pending;
        } finally {
          operation.complete();
          retireSessionControllerInput(input);
          clearSessionControllerMailbox(input.mailbox, () => {});
        }
      }
    },
  );

  it.each(["requester-closed", "source-revoked"] as const)(
    "retains cross-agent custody until %s",
    async (ending) => {
      const sessionKey = `agent:child:dashboard:incognito-custody-${ending}`;
      setRuntimeConfigSnapshot({
        session: {
          store: `${actorEnv.OPENCLAW_STATE_DIR}/agents/{agentId}/sessions/sessions.json`,
        },
      });
      await create(childActor, sessionKey, {
        sessionId: "custody",
        lifecycleRevision: "original",
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
    const created = await create(childActor, sessionKey, {
      sessionId: "child-result",
      lifecycleRevision: "child-result-initial",
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
    const child = createSubagentRunRecord({
      runId,
      childSessionKey: sessionKey,
      childAgentId: "child",
      requesterSessionKey: "agent:main:dashboard:incognito-requester",
      requesterAgentId: "main",
      execution: { status: "terminal", outcome: { status: "ok" } },
      completion: { required: true, terminalReply: { disposition: "visible", text: "Truncated" } },
    });
    const result = await withMemorySource(actor, () =>
      readSubagentRunAnnounceResult(child, () => child),
    );
    expect(result.text).toBe("Complete private result");
    expect(result.isCurrent()).toBe(true);
  });

  it("reads child usage from the selected actor and keeps fresh absence noncreating", async () => {
    const sessionKey = "agent:main:dashboard:incognito-stats";
    setRuntimeConfigSnapshot({ session: { store: actor.path } });
    await create(actor, sessionKey, {
      sessionId: "stats",
      inputTokens: 23,
      outputTokens: 7,
    });
    await expect(
      withMemorySource(actor, () =>
        buildCompactAnnounceStatsLine({ sessionKey, startedAt: 1, endedAt: 1001 }),
      ),
    ).resolves.toBe("Stats: runtime 1s • tokens 30 (in 23 / out 7)");
    const env = { OPENCLAW_STATE_DIR: "/synthetic/announce-absent" };
    const absentPath = actorPath("main", env);
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
  const storePath = actorPath(agentId);
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
