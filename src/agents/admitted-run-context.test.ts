import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  type ExecutionIdentityAdmissionWork,
} from "../audit/execution-identity-admission.js";
import { withPostAdmissionExecutionOwnerBinding } from "../audit/execution-owner-binding.js";
import {
  rotateAgentRunRegistryLifecycleGeneration,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  getGatewayContextResolver,
} from "../plugins/runtime/gateway-context-binding.js";
import {
  closeAdmittedRunDelegatedAuthority,
  createExecutionIdentityRecoveryAdmission,
  createOperationalRunInstanceRef,
  createAdmittedRunOperatorAuthority,
  getAdmittedRunDelegatedAuthority,
  getAdmittedRunSource,
  prepareAgentRunAdmission,
  readAdmittedRunOperatorAuthority,
  readPreparedRunOperatorAuthority,
  retainAdmittedRunBeforeToolCallRecovery,
  resolveAdmittedRunActiveAssertion,
  resolvePreparedRunAdmission,
  type PreparedAgentRunAdmission,
} from "./admitted-run-context.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";

const enabledConfig = { logging: { audit: { enabled: true, executionIdentity: true } } };
const facts = {
  runId: "run-1",
  agentId: "main",
  ingress: { kind: "system" as const, boundary: "test", state: "present" as const },
};

type RunInput = Partial<Parameters<typeof prepareAgentRunAdmission>[0]> & { runId?: string };
function prepareRun({ runId = facts.runId, ...input }: RunInput = {}) {
  const prepared = prepareAgentRunAdmission({
    cfg: {},
    facts: { ...facts, runId },
    operationalRunInstance: createOperationalRunInstanceRef(input.facts?.runId ?? runId),
    ...input,
  });
  onTestFinished(prepared.close);
  return prepared;
}

let cleanupSink: (() => void) | undefined;
function installSink() {
  const sink = vi.fn((_work: ExecutionIdentityAdmissionWork) => true);
  cleanupSink = configureExecutionIdentityAdmissionSink(sink);
  return sink;
}

afterEach(() => {
  cleanupSink?.();
  cleanupSink = undefined;
  vi.restoreAllMocks();
});

describe("prepared run admission", () => {
  it.each([false, true])(
    "owns real fixture authority across module resets and runner settlement (reject=%s)",
    async (reject) => {
      vi.resetModules();
      const admissionOwner = await import("./admitted-run-context.js");
      const failure = new Error("runner failed");
      let assertActive: (() => void) | undefined;
      const run = wrapRunWithTestPreparedAdmission(
        async (params: { runId: string; preparedRunAdmission: PreparedAgentRunAdmission }) => {
          const admitted = await params.preparedRunAdmission.admit("embedded");
          expect(await params.preparedRunAdmission.admit("plugin-harness")).toBe(admitted);
          expect(admitted).not.toHaveProperty("executionIdentityToken");
          assertActive = admissionOwner.resolveAdmittedRunActiveAssertion(admitted);
          expect(assertActive).toBeTypeOf("function");
          assertActive?.();
          if (reject) {
            throw failure;
          }
          return "done";
        },
      );
      const result = run({ runId: `runner-fixture-${reject}` });
      if (reject) {
        await expect(result).rejects.toBe(failure);
      } else {
        await expect(result).resolves.toBe("done");
      }
      expect(() => assertActive?.()).toThrow("no longer active");
    },
  );

  it.each([false, true])(
    "binds Gateway routing after freezing admission (audit=%s)",
    async (audit) => {
      const resolver = () => undefined;
      const prepared = prepareRun({
        cfg: audit ? enabledConfig : {},
        onAdmitted: (context) => {
          expect(Object.isFrozen(context)).toBe(true);
          bindGatewayContextResolver(context, resolver);
        },
      });
      const admitted = await prepared.admit("embedded");
      expect(admitted.operationalRunInstance.runId).toBe(facts.runId);
      expect(Object.isFrozen(admitted.operationalRunInstance)).toBe(true);
      if (!audit) {
        const second = await prepareRun().admit("embedded");
        expect(second.operationalRunInstance.instanceId).not.toBe(
          admitted.operationalRunInstance.instanceId,
        );
        expect(admitted).not.toHaveProperty("executionIdentityToken");
        expect(readAdmittedRunOperatorAuthority(admitted)).toBeUndefined();
      }
      expect(getGatewayContextResolver(admitted)).toBe(resolver);
      expect(getGatewayContextResolver({ ...admitted })).toBeUndefined();
      expect(clearGatewayContextResolver(admitted)).toBe(true);
      expect(getGatewayContextResolver(admitted)).toBeUndefined();
    },
  );

  it("consumes disabled recovery evidence so a reused run id cannot inherit it", async () => {
    const token = createExecutionIdentityAdmissionToken(facts.runId);
    const recovery = createExecutionIdentityRecoveryAdmission({ retryOnly: true, token });

    const disabled = await prepareRun({ recovery }).admit("embedded");
    const laterEnabled = await prepareRun({ cfg: enabledConfig, recovery }).admit("embedded");

    expect(disabled).not.toHaveProperty("executionIdentityToken");
    expect(laterEnabled).not.toHaveProperty("executionIdentityToken");
  });

  it.each([false, true])(
    "adopts the exact saved retry token (explicit binding=%s)",
    async (bound) => {
      const token = createExecutionIdentityAdmissionToken(bound ? "original-run" : facts.runId);
      const sink = installSink();
      const input = {
        retryOnly: true,
        token,
        ...(bound ? { expectedOperationalRunId: facts.runId } : {}),
      };
      if (bound) {
        const rejected = createExecutionIdentityRecoveryAdmission(input);
        expect(rejected.consume("other-operational-run")).toEqual({ accepted: false });
        expect(rejected.consume(facts.runId)).toEqual({ accepted: false });
      }
      const admitted = await prepareRun({
        cfg: enabledConfig,
        recovery: createExecutionIdentityRecoveryAdmission(input),
      }).admit("embedded");
      expect(admitted.executionIdentityToken).toBe(token);
      expect(sink).toHaveBeenCalledExactlyOnceWith({ kind: "retry-reference", token });
    },
  );

  it("keeps missing or mismatched recovery identity unbound", async () => {
    const sink = installSink();
    for (const recovery of [
      createExecutionIdentityRecoveryAdmission({ retryOnly: true }),
      createExecutionIdentityRecoveryAdmission({
        retryOnly: true,
        token: createExecutionIdentityAdmissionToken("different-run"),
      }),
      {
        retryOnly: false,
        token: { ...createExecutionIdentityAdmissionToken(facts.runId) },
      } as never,
    ]) {
      const admitted = await prepareRun({ cfg: enabledConfig, recovery }).admit("embedded");
      expect(admitted).not.toHaveProperty("executionIdentityToken");
    }
    expect(sink).not.toHaveBeenCalled();
  });

  it("allocates once and reuses the first runtime admission across fallback", async () => {
    const sink = installSink();
    const prepared = prepareRun({
      cfg: enabledConfig,
      recovery: createExecutionIdentityRecoveryAdmission({ retryOnly: false }),
    });

    const [first, fallback] = await Promise.all([
      prepared.admit("plugin-harness", "plugin-instance-1"),
      prepared.admit("worker", "worker-instance-1"),
    ]);
    const retry = await prepared.admit("embedded");

    expect(first).toBe(fallback);
    expect(first).toBe(retry);
    expect(first.executionIdentityToken).toBeDefined();
    expect(sink).toHaveBeenCalledExactlyOnceWith({
      kind: "capture",
      envelope: expect.objectContaining({
        contextId: first.executionIdentityToken?.contextId,
        executionId: first.executionIdentityToken?.executionId,
        runtime: { kind: "plugin-harness" },
        runtimeInstanceId: "plugin-instance-1",
      }),
    });
  });

  it("keeps one claim across fallback and never revives it after outer close", async () => {
    const prepared = prepareRun({ runId: "run-lease", admissionSource: "operator-schedule" });
    const input = { runId: "run-lease", preparedRunAdmission: prepared };
    const admitted = await resolvePreparedRunAdmission({ ...input, runtimeKind: "embedded" });
    const first = getAdmittedRunDelegatedAuthority(admitted)!;
    expect(getAdmittedRunSource(first)).toBe("operator-schedule");
    expect(getAdmittedRunSource({ ...first })).toBeUndefined();
    expect(validateAgentRunDelegatedAuthority(first)).toBe(true);
    await expect(
      resolvePreparedRunAdmission({ ...input, runtimeKind: "plugin-harness" }),
    ).resolves.toBe(admitted);
    expect(getAdmittedRunDelegatedAuthority(admitted)).toBe(first);
    prepared.close();
    expect(() => prepared.assertSourceCurrent()).not.toThrow();
    expect(validateAgentRunDelegatedAuthority(first)).toBe(false);
    expect(getAdmittedRunSource(first)).toBeUndefined();
    expect(closeAdmittedRunDelegatedAuthority(admitted)).toBe(false);
    await expect(prepared.admit("embedded")).rejects.toThrow("already closed");
  });

  it.each([undefined, "operator-schedule"] as const)(
    "keeps the original source %s when another admission reuses its live authority",
    async (admissionSource) => {
      const operationalRunInstance = createOperationalRunInstanceRef("source-binding");
      const input = { runId: "source-binding", operationalRunInstance };
      const original = prepareRun({ ...input, admissionSource });
      const replacement = prepareRun({
        ...input,
        admissionSource: admissionSource === undefined ? "operator-schedule" : "requester-schedule",
      });
      const authority = getAdmittedRunDelegatedAuthority(await original.admit("embedded"));
      expect(authority).toBeDefined();
      expect(getAdmittedRunDelegatedAuthority(await replacement.admit("embedded"))).toBe(authority);
      expect(getAdmittedRunSource(authority)).toBe(admissionSource);
    },
  );

  it.each(["replacement", "rotation", "abort"] as const)(
    "invalidates admitted authority after %s",
    async (end) => {
      const input = { runId: "source-lifetime", admissionSource: "operator-schedule" as const };
      const original = prepareRun(input);
      const replacement = prepareRun(input);
      const admitted = await original.admit("embedded");
      const authority = getAdmittedRunDelegatedAuthority(admitted);
      const abort = new AbortController();
      const assertActive = resolveAdmittedRunActiveAssertion(admitted, abort.signal);
      expect(assertActive).toBeDefined();
      expect(() => assertActive?.()).not.toThrow();
      expect(getAdmittedRunSource(authority)).toBe("operator-schedule");
      if (end === "replacement") {
        await replacement.admit("embedded");
      } else if (end === "rotation") {
        rotateAgentRunRegistryLifecycleGeneration();
      } else {
        abort.abort();
      }
      expect(() => assertActive?.()).toThrow("no longer active");
      if (end !== "abort") {
        expect(getAdmittedRunSource(authority)).toBeUndefined();
      }
      original.close();
      expect(() => assertActive?.()).toThrow("no longer active");
      expect(getAdmittedRunSource(authority)).toBeUndefined();
    },
  );

  it("retains the first source failure after revocation without reviving authority", async () => {
    const failure = new Error("Completed-turn transcript anchor changed");
    let sourceFailure: Error | undefined;
    const prepared = prepareRun({
      runId: "source-failure",
      assertSourceCurrent: () => {
        if (sourceFailure) {
          throw sourceFailure;
        }
      },
    });
    const admitted = await prepared.admit("embedded");
    const assertActive = resolveAdmittedRunActiveAssertion(admitted)!;
    assertActive();
    prepared.assertSourceCurrent();
    sourceFailure = failure;
    const revoked = (scope: string) =>
      expect.objectContaining({
        message: `${scope} authority is no longer active`,
        cause: failure,
      });
    expect(assertActive).toThrow(revoked("admitted run"));
    sourceFailure = undefined;
    expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
    expect(assertActive).toThrow(expect.objectContaining({ cause: failure }));
    expect(prepared.assertSourceCurrent).toThrow(revoked("source execution"));
  });

  it("closes generic authority while keeping a recovery-only lease active", async () => {
    const prepared = prepareRun({ runId: "run-private-lease" });
    const admitted = await prepared.admit("embedded");
    const authority = getAdmittedRunDelegatedAuthority(admitted);
    const recovery = retainAdmittedRunBeforeToolCallRecovery(admitted);

    expect(authority).toBeDefined();
    expect(recovery).toBeDefined();
    expect(closeAdmittedRunDelegatedAuthority(admitted)).toBe(true);
    expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
    expect(validateAgentRunDelegatedAuthority(authority!)).toBe(false);
    expect(() => recovery?.assertActive()).not.toThrow();

    recovery?.release();
    expect(() => recovery?.assertActive()).toThrow("no longer active");
    recovery?.release();
  });

  it.each([false, true])(
    "keeps retained native policy fenced after foreground close (refusedRebind=%s)",
    async (refusedRebind) => {
      let current = true;
      const sourceHolds = new Set<symbol>();
      const source = prepareRun({
        runId: "native-source-lease",
        operatorAuthority: createAdmittedRunOperatorAuthority({
          profileId: "native-operator",
          scopes: ["operator.write"],
          assertCurrent: () => {
            if (!current || sourceHolds.size === 0) {
              throw new Error("source claim lost");
            }
          },
          retain: () => {
            const hold = Symbol("source hold");
            sourceHolds.add(hold);
            return () => {
              sourceHolds.delete(hold);
            };
          },
        }),
      });
      const prepared = withPostAdmissionExecutionOwnerBinding(source, () => {});
      expect(readPreparedRunOperatorAuthority(prepared)?.profileId).toBe("native-operator");
      const admitted = await prepared.admit("embedded");
      const recovery = retainAdmittedRunBeforeToolCallRecovery(admitted);
      expect(recovery).toBeDefined();
      const assertRecoveryActive = recovery!.assertActive;
      try {
        if (refusedRebind) {
          const refused = prepareRun({
            runId: "native-source-lease",
            operationalRunInstance: admitted.operationalRunInstance,
            assertSourceCurrent: () => {},
          });
          await expect(refused.admit("embedded")).rejects.toThrow("already bound");
          refused.close();
          expect(assertRecoveryActive).not.toThrow();
        }
        prepared.close();
        expect(sourceHolds.size).toBe(1);
        expect(() => readAdmittedRunOperatorAuthority(admitted)).toThrow("no longer active");
        expect(() => readPreparedRunOperatorAuthority(prepared)).toThrow("no longer active");
        expect(prepared.assertSourceCurrent).not.toThrow();
        expect(assertRecoveryActive).not.toThrow();
        current = false;
        expect(assertRecoveryActive).toThrow("source claim lost");
        current = true;
        expect(assertRecoveryActive).toThrow("source execution authority is no longer active");
        expect(prepared.assertSourceCurrent).toThrow(
          "source execution authority is no longer active",
        );
      } finally {
        recovery?.release();
        prepared.close();
        expect(sourceHolds.size).toBe(0);
      }
    },
  );

  it.each(["hook failure", "outer close"])(
    "closes authority on %s during admission",
    async (end) => {
      const entered = createDeferred();
      const hook = createDeferred();
      let authority: ReturnType<typeof getAdmittedRunDelegatedAuthority>;
      const prepared = prepareRun({
        onAdmitted: async (context) => {
          authority = getAdmittedRunDelegatedAuthority(context);
          entered.resolve();
          await hook.promise;
        },
      });
      const admission = prepared.admit("embedded");
      const rejected = expect(admission).rejects.toThrow(
        end === "hook failure" ? "controller binding failed" : "closed during admission",
      );
      try {
        await entered.promise;
        expect(authority).toBeDefined();
        if (end === "hook failure") {
          hook.reject(new Error("controller binding failed"));
        } else {
          prepared.close();
          expect(validateAgentRunDelegatedAuthority(authority!)).toBe(false);
          hook.resolve();
        }
        await rejected;
        expect(validateAgentRunDelegatedAuthority(authority!)).toBe(false);
      } finally {
        hook.resolve();
        prepared.close();
      }
    },
  );
});
