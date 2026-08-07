import { afterEach, describe, expect, it } from "vitest";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  getExecutionIdentityAdmissionScope,
  type ExecutionIdentityAdmissionWork,
} from "../audit/execution-identity-admission.js";
import {
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  resetAgentRunRegistryForTest,
} from "../infra/agent-run-registry.js";
import { executionIdentity } from "./agent-command-execution-identity.js";
import { createAgentExecutionAttribution } from "./agent-execution-attribution.js";
import type { PreparedAgentCommandExecution } from "./command/prepare.js";

function prepared(params: {
  runId: string;
  enabled: boolean;
  attribution?: PreparedAgentCommandExecution["opts"]["executionAttribution"];
}): PreparedAgentCommandExecution {
  return {
    runId: params.runId,
    cfg: {
      logging: {
        audit: { enabled: params.enabled, executionIdentity: params.enabled },
      },
    },
    opts: {
      message: "test",
      runId: params.runId,
      ...(params.attribution ? { executionAttribution: params.attribution } : {}),
    },
  } as PreparedAgentCommandExecution;
}

describe("agent command execution identity", () => {
  let restoreSink: (() => void) | undefined;

  afterEach(() => {
    restoreSink?.();
    restoreSink = undefined;
    resetAgentRunRegistryForTest();
  });

  it("records the runtime correlation from the canonical admitted attribution", async () => {
    const work: ExecutionIdentityAdmissionWork[] = [];
    restoreSink = configureExecutionIdentityAdmissionSink((item) => {
      work.push(item);
      return true;
    });
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
    });

    await executionIdentity.runPrepared({
      prepared: prepared({ runId: attribution.runId, enabled: true, attribution }),
      run: async (scopedPrepared) => {
        executionIdentity.record({
          agentId: "main",
          cfg: scopedPrepared.cfg,
          ingress: executionIdentity.localIngress,
          runId: attribution.runId,
          runtimeKind: "embedded",
        });
      },
    });

    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      kind: "capture",
      envelope: {
        contextId: attribution.contextId,
        executionId: attribution.executionId,
        createdAt: attribution.createdAt,
      },
    });
    expect(attribution).not.toHaveProperty("executionIdentityAdmission");
  });

  it("uses exact attribution as the lifecycle authority", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-attribution",
    });

    expect(
      executionIdentity.resolveAttribution(
        {
          executionAttribution: attribution,
          lifecycleGeneration: "generation-flat",
        } as never,
        { runId: attribution.runId },
      ),
    ).toEqual({
      attribution,
      lifecycleGeneration: "generation-attribution",
    });
  });

  it("rejects attribution captured for a different run", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-attribution",
      lifecycleGeneration: "generation-attribution",
    });

    expect(() =>
      executionIdentity.resolveAttribution(
        {
          executionAttribution: attribution,
        } as never,
        { runId: "run-command" },
      ),
    ).toThrow("Agent command execution attribution runId does not match the command runId.");
  });

  it("allocates private attribution for direct command admission", () => {
    const resolved = executionIdentity.resolveAttribution(
      { lifecycleGeneration: "generation-local" } as never,
      {
        runId: "run-local",
        sessionKey: "agent:main:local",
        sessionId: "session-local",
        sessionAgentId: "main",
      },
    );

    expect(resolved.attribution).toMatchObject({
      runId: "run-local",
      lifecycleGeneration: "generation-local",
      sessionKey: "agent:main:local",
      sessionId: "session-local",
      agentId: "main",
    });
    expect(resolved.attribution).not.toHaveProperty("executionIdentityAdmission");
  });

  it("atomically reserves one attribution for concurrent cross-session admission", () => {
    const lifecycleGeneration = getAgentRunLifecycleGeneration();
    const runId = "run-shared";
    const first = executionIdentity.resolveAttribution({ lifecycleGeneration } as never, {
      runId,
      sessionKey: "agent:main:first-session",
      sessionId: "first-session",
      sessionAgentId: "main",
    });

    expect(getAgentRunContext(runId)?.attribution).toBe(first.attribution);
    expect(() =>
      executionIdentity.resolveAttribution({ lifecycleGeneration } as never, {
        runId,
        sessionKey: "agent:main:second-session",
        sessionId: "second-session",
        sessionAgentId: "main",
      }),
    ).toThrow("Agent run ID is already bound to different execution attribution.");
    expect(getAgentRunContext(runId)?.attribution).toBe(first.attribution);
  });

  it("replaces attribution only after lifecycle rebound", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
    });
    const opts = { executionAttribution: attribution } as never;

    expect(executionIdentity.replaceAttribution(opts, attribution)).toBe(opts);
    expect(
      executionIdentity.replaceAttribution(
        opts,
        createAgentExecutionAttribution({
          ...attribution,
          lifecycleGeneration: "generation-2",
        }),
      ),
    ).not.toBe(opts);
  });

  it("strips untrusted ingress attribution and preserves trusted gateway attribution", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
    });
    const opts = {
      allowModelOverride: false,
      executionAttribution: attribution,
      lifecycleGeneration: "generation-flat",
      runId: attribution.runId,
    } as never;

    expect(executionIdentity.prepareIngress(opts, false)).toEqual({
      lifecycleGeneration: "generation-flat",
      opts: {
        allowModelOverride: false,
        executionAttribution: undefined,
        lifecycleGeneration: "generation-flat",
        runId: attribution.runId,
      },
    });
    expect(executionIdentity.prepareIngress(opts, true)).toEqual({
      lifecycleGeneration: "generation-flat",
      opts,
    });

    const inheritedOpts = Object.assign(Object.create({ executionAttribution: attribution }), {
      allowModelOverride: false,
      lifecycleGeneration: "generation-flat",
      runId: attribution.runId,
    }) as never;
    expect(executionIdentity.prepareIngress(inheritedOpts, false).opts).toHaveProperty(
      "executionAttribution",
      undefined,
    );
  });
});

describe("prepared agent-command execution identity", () => {
  it("allocates one immutable token per enabled execution and reuses it throughout the run", async () => {
    const observed = await Promise.all(
      [1, 2].map(async (sequence) => {
        const runId = `independent-run-${sequence}`;
        return await executionIdentity.runPrepared({
          prepared: prepared({ runId, enabled: true }),
          run: async (scopedPrepared) => {
            const first = getExecutionIdentityAdmissionScope();
            const fallbackAttempts = [];
            for (const model of ["primary", "fallback-1", "fallback-2"]) {
              await Promise.resolve(model);
              fallbackAttempts.push(getExecutionIdentityAdmissionScope());
            }
            expect(scopedPrepared.opts.executionAttribution).toMatchObject({ runId });
            expect(fallbackAttempts).toEqual([first, first, first]);
            expect(Object.isFrozen(first)).toBe(true);
            expect(Object.isFrozen(first?.token)).toBe(true);
            return first?.token;
          },
        });
      }),
    );

    expect(observed[0]?.runId).toBe("independent-run-1");
    expect(observed[1]?.runId).toBe("independent-run-2");
    expect(observed[0]?.contextId).not.toBe(observed[1]?.contextId);
    expect(observed[0]?.executionId).not.toBe(observed[1]?.executionId);
    expect(getExecutionIdentityAdmissionScope()).toBeUndefined();
  });

  it("adopts only the exact saved retry token", async () => {
    const token = createExecutionIdentityAdmissionToken("retry-run", {
      contextId: "retry-context",
      executionId: "retry-execution",
      now: 123,
    });
    const attribution = createAgentExecutionAttribution({
      runId: "retry-run",
      lifecycleGeneration: "retry-generation",
      executionIdentityAdmission: { token, retryOnly: true },
    });

    await expect(
      executionIdentity.runPrepared({
        prepared: prepared({ runId: "retry-run", enabled: true, attribution }),
        run: async () => getExecutionIdentityAdmissionScope(),
      }),
    ).resolves.toEqual({ token, retryOnly: true });

    await expect(
      executionIdentity.runPrepared({
        prepared: prepared({ runId: "different-run", enabled: true, attribution }),
        run: async () => undefined,
      }),
    ).rejects.toThrow(
      "Agent command execution attribution runId does not match the command runId.",
    );
  });

  it("derives the ambient token from canonical execution attribution", async () => {
    const attribution = createAgentExecutionAttribution({
      runId: "attributed-run",
      lifecycleGeneration: "attributed-generation",
    });

    await expect(
      executionIdentity.runPrepared({
        prepared: prepared({ runId: "attributed-run", enabled: true, attribution }),
        run: async () => getExecutionIdentityAdmissionScope(),
      }),
    ).resolves.toEqual({
      retryOnly: false,
      token: {
        tokenVersion: 1,
        runId: attribution.runId,
        contextId: attribution.contextId,
        executionId: attribution.executionId,
        createdAt: attribution.createdAt,
      },
    });
  });

  it("isolates independent child roots from an inherited parent identity", async () => {
    await executionIdentity.runPrepared({
      prepared: prepared({ runId: "parent-run", enabled: true }),
      run: async () => {
        const parent = getExecutionIdentityAdmissionScope();
        await Promise.resolve();
        const child = await executionIdentity.runPrepared({
          prepared: prepared({ runId: "child-run", enabled: true }),
          run: async () => getExecutionIdentityAdmissionScope(),
        });
        expect(child?.token.runId).toBe("child-run");
        expect(child?.token.executionId).not.toBe(parent?.token.executionId);
        expect(getExecutionIdentityAdmissionScope()).toBe(parent);
      },
    });
  });

  it("keeps valid overlong public run identifiers nonblocking and unscoped", async () => {
    const runId = "r".repeat(257);
    await expect(
      executionIdentity.runPrepared({
        prepared: prepared({ runId, enabled: true }),
        run: async () => ({ ran: true, scope: getExecutionIdentityAdmissionScope() }),
      }),
    ).resolves.toEqual({ ran: true, scope: undefined });
  });

  it("retains canonical attribution without creating a scope while collection is disabled", async () => {
    const token = createExecutionIdentityAdmissionToken("disabled-run");
    const attribution = createAgentExecutionAttribution({
      runId: "disabled-run",
      lifecycleGeneration: "disabled-generation",
      executionIdentityAdmission: { token, retryOnly: true },
    });
    await expect(
      executionIdentity.runPrepared({
        prepared: prepared({ runId: "disabled-run", enabled: false, attribution }),
        run: async (scopedPrepared) => ({
          scope: getExecutionIdentityAdmissionScope(),
          retained: scopedPrepared.opts.executionAttribution,
        }),
      }),
    ).resolves.toEqual({ scope: undefined, retained: attribution });
  });
});
