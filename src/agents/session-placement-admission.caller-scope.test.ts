import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  seedActivePlacement,
  SESSION_ID,
  SESSION_KEY,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "../gateway/worker-environments/worker-turn-launcher.test-support.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "./admitted-run-context.js";
import { createDeferredEmbeddedRunLifecycleManager } from "./embedded-agent-runner/run/deferred-lifecycle-owner.js";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunHandleActive,
  resolveActiveEmbeddedRunOwner,
  setActiveEmbeddedRun,
} from "./embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "./embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "./harness/tool-authority.runtime.js";
import {
  installSessionPlacementAdmissionProvider,
  withLocalSessionPlacementTurnSettlement,
  withSessionPlacementTurnAdmission,
} from "./session-placement-admission.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

let uninstall: (() => void) | undefined;

// Enter a real live parent attempt, as an in-process sessions tool does.
async function fromParent(
  run: (owner: {
    admittedRunContext: AdmittedRunContext;
    preparedRunAdmission: PreparedAgentRunAdmission;
    register: () => void;
  }) => Promise<void>,
) {
  const parent = {
    sessionId: "parent-session",
    sessionKey: "agent:main:parent",
    sessionFile: "agent:main:parent",
    agentId: "main",
    runId: "parent-run",
    workspaceDir: "/unused-parent-workspace",
    config: {},
    provider: "openai",
    modelId: "gpt-test",
  };
  const admission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(parent.runId),
    facts: {
      agentId: parent.agentId,
      runId: parent.runId,
      ingress: { kind: "system", state: "present", boundary: "caller-scope-test" },
    },
  });
  const admittedRunContext = await admission.admit("embedded");
  const handle = createEmbeddedRunHandle({ runId: parent.runId });
  try {
    await withPreparedEmbeddedRunToolAuthority(
      { admittedRunContext },
      parent,
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
      seedActivePlacement();
      const input = turn(scenario === "reused run id" ? "parent-run" : "child-worker-run");
      const reachedWorkerExecution = new Error("test worker execution reached");
      const get = vi.fn(() => {
        expect(resolveActiveEmbeddedRunOwner(SESSION_ID)?.runId).toBe(input.runId);
        throw reachedWorkerExecution;
      });
      uninstall = installSessionPlacementAdmissionProvider(
        createWorkerSessionTurnPlacementProvider({
          placements,
          environments: { ...unusedEnvironments(), get },
        }),
      );
      try {
        let queued: Promise<void> | undefined;
        let release!: () => void;
        const ready = new Promise<void>((resolve) => {
          release = resolve;
        });
        await fromParent(async () => {
          const execute = async () => {
            await expect(
              withSessionPlacementTurnAdmission(
                {
                  sessionId: SESSION_ID,
                  sessionKey: SESSION_KEY,
                  agentId: "main",
                  runId: input.runId,
                },
                input,
                vi.fn(),
              ),
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
        expect(get).toHaveBeenCalledOnce();
        expect(isEmbeddedAgentRunHandleActive(SESSION_ID)).toBe(false);
        expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      } finally {
        input.preparedRunAdmission.close();
      }
    },
  );

  it("registers the direct CLI handoff under its own placement lifecycle", async () => {
    const input = turn("child-cli-run");
    const lifecycle = createDeferredEmbeddedRunLifecycleManager(input);
    uninstall = installSessionPlacementAdmissionProvider(
      createWorkerSessionTurnPlacementProvider({
        placements,
        environments: unusedEnvironments(),
      }),
    );
    try {
      await fromParent(async () => {
        await withLocalSessionPlacementTurnSettlement(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: input.runId,
          },
          async (assertCurrent) => {
            assertCurrent();
            lifecycle.handoffToCli();
            expect(resolveActiveEmbeddedRunOwner(SESSION_ID)?.runId).toBe(input.runId);
            await lifecycle.complete();
            return { meta: { durationMs: 0 } };
          },
          { preparedRunAdmission: input.preparedRunAdmission },
        );
      });
      expect(isEmbeddedAgentRunHandleActive(SESSION_ID)).toBe(false);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    } finally {
      await lifecycle.complete();
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
        const claim = {
          sessionId: "parent-session",
          sessionKey: "agent:main:parent",
          agentId: "main",
          runId: "parent-run",
        };
        const execute = async () => {
          owner.register();
          expect(resolveActiveEmbeddedRunOwner(claim.sessionId)?.runId).toBe(claim.runId);
          await Promise.resolve();
          owner.preparedRunAdmission.close();
          expect(owner.register).toThrow(/no longer active/);
          return { meta: { durationMs: 0 } };
        };
        const input = {
          ...claim,
          ...admission,
          sessionFile: claim.sessionKey,
          workspaceDir: "/unused-parent-workspace",
          prompt: "test",
          timeoutMs: 1000,
        };
        if (path === "embedded") {
          await withSessionPlacementTurnAdmission(claim, input, execute);
        } else {
          await withLocalSessionPlacementTurnSettlement(claim, execute, admission);
        }
      });
    },
  );
});
