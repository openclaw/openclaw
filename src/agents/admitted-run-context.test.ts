import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as audit from "../audit/execution-identity-admission.js";
import { withPostAdmissionExecutionOwnerBinding } from "../audit/execution-owner-binding.js";
import {
  rotateAgentRunRegistryLifecycleGeneration,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import * as gateway from "../plugins/runtime/gateway-context-binding.js";
import * as run from "./admitted-run-context.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";

const enabledConfig = { logging: { audit: { enabled: true, executionIdentity: true } } };
const facts = {
  runId: "run-1",
  agentId: "main",
  ingress: { kind: "system" as const, boundary: "test", state: "present" as const },
};

type RunInput = Partial<Parameters<typeof run.prepareAgentRunAdmission>[0]> & { runId?: string };
function prepareRun({ runId = facts.runId, ...input }: RunInput = {}) {
  const prepared = run.prepareAgentRunAdmission({
    cfg: {},
    facts: { ...facts, runId },
    operationalRunInstance: run.createOperationalRunInstanceRef(input.facts?.runId ?? runId),
    ...input,
  });
  onTestFinished(prepared.close);
  return prepared;
}

function installSink() {
  const sink = vi.fn((_work: audit.ExecutionIdentityAdmissionWork) => true);
  onTestFinished(audit.configureExecutionIdentityAdmissionSink(sink));
  return sink;
}

afterEach(() => vi.restoreAllMocks());

it.each([false, true])("settles reset-module fixtures (reject=%s)", async (reject) => {
  vi.resetModules();
  const admissionOwner = await import("./admitted-run-context.js");
  const failure = new Error("runner failed");
  let assertActive: (() => void) | undefined;
  const runner = wrapRunWithTestPreparedAdmission(
    async (params: { runId: string; preparedRunAdmission: run.PreparedAgentRunAdmission }) => {
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
  const result = runner({ runId: `runner-fixture-${reject}` });
  if (reject) {
    await expect(result).rejects.toBe(failure);
  } else {
    await expect(result).resolves.toBe("done");
  }
  expect(() => assertActive?.()).toThrow("no longer active");
});

it.each([false, true])("binds frozen Gateway routing (audit=%s)", async (enabled) => {
  const resolver = () => undefined;
  const prepared = prepareRun({
    cfg: enabled ? enabledConfig : {},
    onAdmitted: (context) => {
      expect(Object.isFrozen(context)).toBe(true);
      gateway.bindGatewayContextResolver(context, resolver);
    },
  });
  const admitted = await prepared.admit("embedded");
  expect(admitted.operationalRunInstance.runId).toBe(facts.runId);
  expect(Object.isFrozen(admitted.operationalRunInstance)).toBe(true);
  if (!enabled) {
    const second = await prepareRun().admit("embedded");
    expect(second.operationalRunInstance.instanceId).not.toBe(
      admitted.operationalRunInstance.instanceId,
    );
    expect(admitted).not.toHaveProperty("executionIdentityToken");
    expect(run.readAdmittedRunOperatorAuthority(admitted)).toBeUndefined();
  }
  expect(gateway.getGatewayContextResolver(admitted)).toBe(resolver);
  expect(gateway.getGatewayContextResolver({ ...admitted })).toBeUndefined();
  expect(gateway.clearGatewayContextResolver(admitted)).toBe(true);
  expect(gateway.getGatewayContextResolver(admitted)).toBeUndefined();
});

it("consumes disabled recovery evidence so a reused run id cannot inherit it", async () => {
  const token = audit.createExecutionIdentityAdmissionToken(facts.runId);
  const recovery = run.createExecutionIdentityRecoveryAdmission({ retryOnly: true, token });

  const disabled = await prepareRun({ recovery }).admit("embedded");
  const laterEnabled = await prepareRun({ cfg: enabledConfig, recovery }).admit("embedded");

  expect(disabled).not.toHaveProperty("executionIdentityToken");
  expect(laterEnabled).not.toHaveProperty("executionIdentityToken");
});

it.each([false, true])("adopts exact retry evidence (bound=%s)", async (bound) => {
  const token = audit.createExecutionIdentityAdmissionToken(bound ? "original-run" : facts.runId);
  const sink = installSink();
  const recovery = () =>
    run.createExecutionIdentityRecoveryAdmission({
      retryOnly: true,
      token,
      ...(bound ? { expectedOperationalRunId: facts.runId } : {}),
    });
  if (bound) {
    const rejected = recovery();
    expect([rejected.consume("other-operational-run"), rejected.consume(facts.runId)]).toEqual([
      { accepted: false },
      { accepted: false },
    ]);
  }
  const admitted = await prepareRun({ cfg: enabledConfig, recovery: recovery() }).admit("embedded");
  expect(admitted.executionIdentityToken).toBe(token);
  expect(sink).toHaveBeenCalledExactlyOnceWith({ kind: "retry-reference", token });
});

it("keeps missing or mismatched recovery identity unbound", async () => {
  const sink = installSink();
  for (const recovery of [
    run.createExecutionIdentityRecoveryAdmission({ retryOnly: true }),
    run.createExecutionIdentityRecoveryAdmission({
      retryOnly: true,
      token: audit.createExecutionIdentityAdmissionToken("different-run"),
    }),
    {
      retryOnly: false,
      token: { ...audit.createExecutionIdentityAdmissionToken(facts.runId) },
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
    recovery: run.createExecutionIdentityRecoveryAdmission({ retryOnly: false }),
  });

  const [first, fallback] = await Promise.all([
    prepared.admit("plugin-harness", "plugin-instance-1"),
    prepared.admit("worker", "worker-instance-1"),
  ]);
  expect(first).toBe(fallback);
  expect(await prepared.admit("embedded")).toBe(first);
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
  const admitted = await run.resolvePreparedRunAdmission({ ...input, runtimeKind: "embedded" });
  const first = run.getAdmittedRunDelegatedAuthority(admitted)!;
  expect(run.getAdmittedRunSource(first)).toBe("operator-schedule");
  expect(run.getAdmittedRunSource({ ...first })).toBeUndefined();
  expect(validateAgentRunDelegatedAuthority(first)).toBe(true);
  await expect(
    run.resolvePreparedRunAdmission({ ...input, runtimeKind: "plugin-harness" }),
  ).resolves.toBe(admitted);
  expect(run.getAdmittedRunDelegatedAuthority(admitted)).toBe(first);
  prepared.close();
  expect(() => prepared.assertSourceCurrent()).not.toThrow();
  expect(validateAgentRunDelegatedAuthority(first)).toBe(false);
  expect(run.getAdmittedRunSource(first)).toBeUndefined();
  expect(run.closeAdmittedRunDelegatedAuthority(admitted)).toBe(false);
  await expect(prepared.admit("embedded")).rejects.toThrow("already closed");
});

it.each([undefined, "operator-schedule"] as const)("reuses source %s", async (admissionSource) => {
  const operationalRunInstance = run.createOperationalRunInstanceRef("source-binding");
  const input = { runId: "source-binding", operationalRunInstance };
  const original = prepareRun({ ...input, admissionSource });
  const replacement = prepareRun({
    ...input,
    admissionSource: admissionSource === undefined ? "operator-schedule" : "requester-schedule",
  });
  const authority = run.getAdmittedRunDelegatedAuthority(await original.admit("embedded"));
  expect(authority).toBeDefined();
  expect(run.getAdmittedRunDelegatedAuthority(await replacement.admit("embedded"))).toBe(authority);
  expect(run.getAdmittedRunSource(authority)).toBe(admissionSource);
});

it.each(["replacement", "rotation", "abort"] as const)("revokes after %s", async (end) => {
  const input = { runId: "source-lifetime", admissionSource: "operator-schedule" as const };
  const original = prepareRun(input);
  const replacement = prepareRun(input);
  const admitted = await original.admit("embedded");
  const authority = run.getAdmittedRunDelegatedAuthority(admitted);
  const abort = new AbortController();
  const assertActive = run.resolveAdmittedRunActiveAssertion(admitted, abort.signal);
  expect(assertActive).toBeDefined();
  expect(() => assertActive?.()).not.toThrow();
  expect(run.getAdmittedRunSource(authority)).toBe("operator-schedule");
  if (end === "replacement") {
    await replacement.admit("embedded");
  } else if (end === "rotation") {
    rotateAgentRunRegistryLifecycleGeneration();
  } else {
    abort.abort();
  }
  expect(() => assertActive?.()).toThrow("no longer active");
  if (end !== "abort") {
    expect(run.getAdmittedRunSource(authority)).toBeUndefined();
  }
  original.close();
  expect(() => assertActive?.()).toThrow("no longer active");
  expect(run.getAdmittedRunSource(authority)).toBeUndefined();
});

it("retains the first source failure after revocation without reviving authority", async () => {
  const failure = new Error("Completed-turn transcript anchor changed");
  const source = vi.fn<() => void>();
  const prepared = prepareRun({ assertSourceCurrent: source });
  const admitted = await prepared.admit("embedded");
  const assertActive = run.resolveAdmittedRunActiveAssertion(admitted)!;
  assertActive();
  prepared.assertSourceCurrent();
  source.mockImplementation(() => {
    throw failure;
  });
  const revoked = (scope: string) =>
    expect.objectContaining({
      message: `${scope} authority is no longer active`,
      cause: failure,
    });
  expect(assertActive).toThrow(revoked("admitted run"));
  source.mockReset();
  expect(run.getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
  expect(assertActive).toThrow(expect.objectContaining({ cause: failure }));
  expect(prepared.assertSourceCurrent).toThrow(revoked("source execution"));
});

it("closes generic authority while keeping a recovery-only lease active", async () => {
  const prepared = prepareRun({ runId: "run-private-lease" });
  const admitted = await prepared.admit("embedded");
  const authority = run.getAdmittedRunDelegatedAuthority(admitted);
  const recovery = run.retainAdmittedRunBeforeToolCallRecovery(admitted);

  expect(authority).toBeDefined();
  expect(recovery).toBeDefined();
  expect(run.closeAdmittedRunDelegatedAuthority(admitted)).toBe(true);
  expect(run.getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
  expect(validateAgentRunDelegatedAuthority(authority!)).toBe(false);
  expect(() => recovery?.assertActive()).not.toThrow();

  recovery?.release();
  expect(() => recovery?.assertActive()).toThrow("no longer active");
  recovery?.release();
});

it.each([false, true])("fences native recovery (refusedRebind=%s)", async (refusedRebind) => {
  let current = true;
  let sourceHolds = 0;
  const source = prepareRun({
    runId: "native-source-lease",
    operatorAuthority: run.createAdmittedRunOperatorAuthority({
      profileId: "native-operator",
      scopes: ["operator.write"],
      assertCurrent: () => {
        if (!current || sourceHolds === 0) {
          throw new Error("source claim lost");
        }
      },
      retain: () => {
        sourceHolds++;
        return () => sourceHolds--;
      },
    }),
  });
  const prepared = withPostAdmissionExecutionOwnerBinding(source, () => {});
  expect(run.readPreparedRunOperatorAuthority(prepared)?.profileId).toBe("native-operator");
  const admitted = await prepared.admit("embedded");
  const recovery = run.retainAdmittedRunBeforeToolCallRecovery(admitted);
  expect(recovery).toBeDefined();
  const assertRecoveryActive = recovery!.assertActive;
  onTestFinished(() => {
    recovery?.release();
    prepared.close();
    expect(sourceHolds).toBe(0);
  });
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
  expect(sourceHolds).toBe(1);
  expect(() => run.readAdmittedRunOperatorAuthority(admitted)).toThrow("no longer active");
  expect(() => run.readPreparedRunOperatorAuthority(prepared)).toThrow("no longer active");
  expect(prepared.assertSourceCurrent).not.toThrow();
  expect(assertRecoveryActive).not.toThrow();
  current = false;
  expect(assertRecoveryActive).toThrow("source claim lost");
  current = true;
  expect(assertRecoveryActive).toThrow("source execution authority is no longer active");
  expect(prepared.assertSourceCurrent).toThrow("source execution authority is no longer active");
});

it.each(["hook failure", "outer close"])("closes authority on %s during admission", async (end) => {
  const entered = createDeferred();
  const hook = createDeferred();
  let authority: ReturnType<typeof run.getAdmittedRunDelegatedAuthority>;
  const prepared = prepareRun({
    onAdmitted: async (context) => {
      authority = run.getAdmittedRunDelegatedAuthority(context);
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
});
