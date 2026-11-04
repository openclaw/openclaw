import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  assertOwnedTranscriptWriteCommit,
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../config/sessions/transcript-write-context.js";
import {
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  seedActivePlacement,
  SESSION_ID,
  SESSION_KEY,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "../gateway/worker-environments/worker-turn-launcher.test-support.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "./admitted-run-context.js";
import { createDeferredEmbeddedRunLifecycleManager } from "./embedded-agent-runner/run/deferred-lifecycle-owner.js";
import {
  isEmbeddedAgentRunHandleActive,
  resolveActiveEmbeddedRunOwner,
} from "./embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "./embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "./harness/tool-authority.runtime.js";
import {
  installSessionPlacementAdmissionProvider,
  withLocalSessionPlacementTurnSettlement,
  withSessionPlacementTurnAdmission,
} from "./session-placement-admission.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

let uninstall: (() => void) | undefined;
const parentClaim = {
  sessionId: "parent-session",
  sessionKey: "agent:main:parent",
  agentId: "main",
  runId: "parent-run",
};
const parent = {
  ...parentClaim,
  sessionFile: parentClaim.sessionKey,
  workspaceDir: "/unused-parent-workspace",
  provider: "openai",
  modelId: "gpt-test",
};
const childClaim = (runId: string) => ({
  sessionId: SESSION_ID,
  sessionKey: SESSION_KEY,
  agentId: "main",
  runId,
});
function installWorkerProvider(environments = unusedEnvironments()) {
  uninstall = installSessionPlacementAdmissionProvider(
    createWorkerSessionTurnPlacementProvider({ placements, environments }),
  );
}
function expectChildReleased() {
  expect(isEmbeddedAgentRunHandleActive(SESSION_ID)).toBe(false);
  expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
}

// Enter a real live parent attempt, as an in-process sessions tool does.
async function fromParent(
  run: (owner: {
    admittedRunContext: AdmittedRunContext;
    preparedRunAdmission: PreparedAgentRunAdmission;
    register: () => void;
  }) => Promise<void>,
) {
  const admission = prepareSystemAgentRunAdmission(
    {},
    parent.runId,
    parent.agentId,
    "caller-scope-test",
  );
  const admittedRunContext = await admission.admit("embedded");
  const handle = createEmbeddedRunHandle({ runId: parent.runId });
  try {
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: {
          ...parentClaim,
          storePath: sessionTarget.storePath,
          expectedWriterRunId: parent.runId,
        },
        assertCommitAllowed: resolveAdmittedRunActiveAssertion(admittedRunContext),
        withTranscriptWrite: async (write) => await write(),
      },
      () =>
        withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext },
          { ...parent, config: { session: { store: sessionTarget.storePath } } },
          undefined,
          async (prepared) => {
            const caller = getGatewayToolCallerIdentity()!;
            handle.toolAuthorityFingerprint = prepared.toolAuthorityFingerprint;
            await run({
              admittedRunContext,
              preparedRunAdmission: admission,
              register: () =>
                setActiveEmbeddedRun(
                  parent.sessionId,
                  handle,
                  parent.sessionKey,
                  parent.sessionFile,
                  parent.agentId,
                ),
            });
            expect(getGatewayToolCallerIdentity()).toBe(caller);
          },
        ),
    );
  } finally {
    clearActiveEmbeddedRun(parent.sessionId, handle, parent.sessionKey, parent.sessionFile);
    admission.close();
  }
}

describe("independent placement caller scope", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(async () => {
    uninstall?.();
    uninstall = undefined;
    await cleanupWorkerTurnLauncherTest();
  });

  it.each(["live parent", "closed parent", "reused run id"])(
    "registers a worker proxy without consuming authority from a %s",
    async (scenario) => {
      await seedActivePlacement();
      const reachedWorkerExecution = new Error("test worker execution reached");
      const input = {
        ...turn(scenario === "reused run id" ? "parent-run" : "child-worker-run"),
        onExecutionStarted: () => {
          expect(resolveActiveEmbeddedRunOwner(SESSION_ID)?.runId).toBe(input.runId);
          throw reachedWorkerExecution;
        },
      };
      installWorkerProvider({ ...unusedEnvironments(), get: attachedEnvironment });
      try {
        let queued: Promise<void> | undefined;
        const { promise: ready, resolve: release } = createDeferred();
        await fromParent(async () => {
          const execute = async () => {
            await expect(
              withSessionPlacementTurnAdmission(childClaim(input.runId), input, vi.fn()),
            ).rejects.toBe(reachedWorkerExecution);
          };
          if (scenario === "closed parent") {
            // Queue while parent ALS is active, then let its attempt close first.
            queued = ready.then(execute);
          } else {
            await execute();
          }
        });
        release();
        await queued;
        expectChildReleased();
      } finally {
        input.preparedRunAdmission.close();
      }
    },
  );

  it("registers the direct CLI handoff under its own placement lifecycle", async () => {
    const input = turn("child-cli-run");
    let lifecycle: ReturnType<typeof createDeferredEmbeddedRunLifecycleManager> | undefined;
    installWorkerProvider();
    try {
      await fromParent(async () => {
        await withLocalSessionPlacementTurnSettlement(
          childClaim(input.runId),
          async (assertCurrent) => {
            assertCurrent();
            lifecycle = createDeferredEmbeddedRunLifecycleManager(input);
            lifecycle.handoffToCli();
            expect(resolveActiveEmbeddedRunOwner(SESSION_ID)?.runId).toBe(input.runId);
            await lifecycle.complete();
            return { meta: { durationMs: 0 } };
          },
          { preparedRunAdmission: input.preparedRunAdmission },
        );
      });
      expectChildReleased();
    } finally {
      await lifecycle?.complete();
      input.preparedRunAdmission.close();
    }
  });

  it.each([
    { path: "embedded", carrier: "prepared" },
    { path: "embedded", carrier: "admitted" },
    { path: "cli", carrier: "prepared" },
    { path: "cli", carrier: "admitted" },
  ] as const)(
    "retains exact $carrier $path authority and rejects registration after closure",
    async ({ path, carrier }) => {
      await fromParent(async (owner) => {
        const admission =
          carrier === "prepared"
            ? { preparedRunAdmission: owner.preparedRunAdmission }
            : { admittedRunContext: owner.admittedRunContext };
        const execute = async () => {
          const target = { ...parentClaim, storePath: sessionTarget.storePath };
          const commit = vi.fn();
          const write = () =>
            runWithOwnedSessionTranscriptWrite({ sessionTarget: target }, () => {
              assertOwnedTranscriptWriteCommit(target);
              commit();
            });
          await write();
          owner.register();
          expect(resolveActiveEmbeddedRunOwner(parent.sessionId)?.runId).toBe(parent.runId);
          await Promise.resolve();
          owner.preparedRunAdmission.close();
          expect(owner.register).toThrow(/no longer active/);
          await expect(write()).rejects.toThrow(/no longer active/);
          expect(commit).toHaveBeenCalledOnce();
          return { meta: { durationMs: 0 } };
        };
        const input = {
          ...parentClaim,
          ...admission,
          sessionFile: parent.sessionFile,
          workspaceDir: parent.workspaceDir,
          prompt: "test",
          timeoutMs: 1000,
        };
        if (path === "embedded") {
          await withSessionPlacementTurnAdmission(parentClaim, input, execute);
        } else {
          await withLocalSessionPlacementTurnSettlement(parentClaim, execute, admission);
        }
      });
    },
  );
});
