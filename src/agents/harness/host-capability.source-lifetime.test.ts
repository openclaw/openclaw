import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import {
  captureExecRequestCustodySelection,
  captureExecRequestOwners,
  withExecRequestTurn,
} from "../../infra/exec-request-context.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { testTool } from "./host-capability.shard.test-support.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

const cleanup: Array<() => void> = [];

async function createSourceHost(
  operatorAuthority?: AdmittedRunOperatorAuthority,
  abortSignal?: AbortSignal,
  nativeModelPolicySupport?: "exact",
  attempt: Partial<Parameters<typeof createAdmittedHostCapabilityTestFixture>[0]> = {},
) {
  const host = await createAdmittedHostCapabilityTestFixture(
    { runId: "retained-source", abortSignal, ...attempt },
    { operatorAuthority, nativeModelPolicySupport },
  );
  cleanup.push(host.closeAdmission, host.closeHost);
  return host;
}

function retain(host: Awaited<ReturnType<typeof createSourceHost>>) {
  const retained = host.hostCapabilities.retainSourceAuthority?.();
  assert(retained, "expected retained source authority");
  cleanup.push(retained.release);
  return retained;
}

function bindModel(retained: ReturnType<typeof retain>) {
  const binding = retained.bindModelExecution?.({ provider: "fixture", model: "a" });
  assert(binding, "expected retained model execution authority");
  cleanup.push(binding.release);
  return binding;
}

afterEach(() => {
  for (const release of cleanup.splice(0).toReversed()) {
    release();
  }
  resetAgentRunRegistryForTest();
});

it("returns no retained source authority without an operator", async () => {
  const host = await createSourceHost();
  expect(host.hostCapabilities.retainSourceAuthority?.()).toBeUndefined();
  host.closeHost();
  expect(() => host.hostCapabilities.retainSourceAuthority?.()).toThrow("no longer active");
});

it("records completed turn bookkeeping while revocation blocks the next tool effect", async () => {
  let current = true;
  const source = createAdmittedRunOperatorAuthority({
    profileId: "bookkeeping-source",
    scopes: ["operator.write"],
    assertCurrent: () => {
      if (!current) {
        throw new Error("operator source revoked");
      }
    },
  });
  const recorder = { recordEvent: vi.fn(), flush: vi.fn(async () => {}) };
  const fixture = await createSourceHost(source, undefined, undefined, {
    runId: "bookkeeping-source",
    agentId: "main",
    sessionKey: "agent:main:bookkeeping",
    trajectoryRecorder: recorder,
  });
  const host = await withGatewayToolCallerIdentity(
    createAdmittedGatewayToolCallerIdentity(fixture.attempt),
    () => createAgentHarnessHostCapabilities({ attempt: fixture.attempt, pluginId: "codex" }),
  );
  cleanup.push(host.close);
  const { tool, execute } = testTool();
  const bound = host.capabilities.bindToolSurface([tool])[0]!;
  await bound.execute("before-revocation", {});
  await Promise.resolve();
  current = false;
  host.capabilities.reportOutputTokens?.(12);
  host.capabilities.trajectory!.recordEvent("completed-output", { outputTokens: 12 });
  expect(recorder.recordEvent).toHaveBeenCalledWith("completed-output", { outputTokens: 12 });
  await expect(bound.execute("after-revocation", {})).rejects.toThrow("no longer active");
  expect(execute).toHaveBeenCalledOnce();
});

it.each([
  "source assertion",
  "lifecycle rotation",
  "gateway rotation",
  "synchronous signal",
  "synchronous lifecycle",
] as const)(
  "fences retained source authority after foreground completion on %s",
  async (revocation) => {
    const synchronous = revocation.startsWith("synchronous");
    const foreground = new AbortController();
    const controller = new AbortController();
    const revoked = new Error("operator access revoked");
    let current = true;
    let duringAssertion: (() => void) | undefined;
    const source = createAdmittedRunOperatorAuthority({
      profileId: "guest-source",
      scopes: ["operator.write"],
      ...(synchronous ? { signal: controller.signal } : {}),
      assertCurrent: () => {
        if (!current) {
          throw revoked;
        }
        duringAssertion?.();
      },
    });
    const foregroundAbort = !synchronous && revocation !== "gateway rotation";
    const host = await createSourceHost(
      source,
      foregroundAbort ? foreground.signal : undefined,
      revocation === "synchronous lifecycle" ? undefined : "exact",
    );
    const retained = retain(host);
    if (foregroundAbort) {
      expect(retained.signal?.aborted).toBe(false);
    }
    host.closeHost();
    host.closeAdmission();
    if (synchronous) {
      duringAssertion =
        revocation === "synchronous signal"
          ? () => controller.abort(new Error("source revoked during validation"))
          : rotateAgentRunRegistryLifecycleGeneration;
      expect(() => retained.assertCurrent()).toThrow();
      if (revocation === "synchronous signal") {
        expect(retained.signal?.aborted).toBe(true);
      }
      return;
    }
    if (foregroundAbort) {
      foreground.abort();
      expect(() => retained.assertCurrent()).not.toThrow();
    }
    const modelBinding = bindModel(retained);
    if (revocation === "source assertion") {
      current = false;
    } else if (revocation === "gateway rotation") {
      rotateAgentEventLifecycleGeneration();
      expect(retained.signal?.aborted).toBe(true);
      expect(modelBinding.signal.aborted).toBe(true);
    } else {
      rotateAgentRunRegistryLifecycleGeneration();
      expect(() => source.assertCurrent()).not.toThrow();
    }
    const expected = revocation === "source assertion" ? revoked : "no longer active";
    expect(() => retained.assertCurrent()).toThrow(expected);
    expect(modelBinding.assertCurrent).toThrow(
      revocation === "gateway rotation" ? expected : undefined,
    );
    if (revocation === "source assertion") {
      expect(modelBinding.signal.aborted).toBe(true);
    }
    current = true;
    expect(() => retained.assertCurrent()).toThrow(expected);
  },
);

it("releases model authority when its retained work closes during acquisition", async () => {
  let sourceHolds = 0;
  const acquisition: { close?: () => void } = {};
  const source = createAdmittedRunOperatorAuthority({
    profileId: "guest-source",
    scopes: ["operator.write"],
    assertCurrent: () => {},
    retain: () => {
      sourceHolds += 1;
      acquisition.close?.();
      return () => {
        sourceHolds -= 1;
      };
    },
  });
  const host = await createSourceHost(source, undefined, "exact");
  const retained = retain(host);
  host.closeHost();
  host.closeAdmission();
  expect(sourceHolds).toBe(1);
  acquisition.close = retained.release;
  expect(() => retained.bindModelExecution?.({ provider: "fixture", model: "a" })).toThrow(
    "no longer active",
  );
  expect(sourceHolds).toBe(0);
});

it("guards retained unknown-model work through policy introduction and releases once", async () => {
  const current: { policy?: AdmittedRunOperatorAuthority["modelPolicy"] } = {};
  let holds = 0;
  const listeners = new Set<() => void>();
  const source = createAdmittedRunOperatorAuthority({
    profileId: "retained-policy",
    scopes: ["operator.write"],
    assertCurrent: () => {},
    get modelPolicy() {
      return current.policy;
    },
    onModelPolicyChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retain: () => {
      holds += 1;
      return () => {
        holds -= 1;
      };
    },
  });
  const host = await createSourceHost(source);
  expect(host.hostCapabilities.bindModelExecution).toBeUndefined();
  const retained = retain(host);
  host.closeHost();
  host.closeAdmission();
  expect(holds).toBe(1);
  expect(() => retained.assertCurrent()).not.toThrow();
  expect(retained.signal?.aborted).toBe(false);
  current.policy = prepareOperatorModelPolicy({
    cfg: { agents: { defaults: { model: "fixture/a" } } },
    policy: {},
    manifestPlugins: [],
  });
  for (const listener of listeners) {
    listener();
  }
  expect(retained.signal?.aborted).toBe(true);
  expect(() => retained.assertCurrent()).toThrow("operator role cannot use this model");
  retained.release();
  retained.release();
  expect([holds, listeners.size]).toEqual([0, 0]);
});

it("captures request custody before plugin handoff and retains continuation ancestry", async () => {
  const identity = {
    runId: "retained-source",
    sessionKey: "agent:main:request-custody",
    sessionId: "physical-session",
    ownerConnId: "request-owner",
  };
  const captured = await withExecRequestTurn({ identity }, async () => {
    const host = await createSourceHost(undefined, undefined, undefined, identity);
    return { host, owners: captureExecRequestOwners(identity) };
  });
  const host = captured.host.hostCapabilities;
  const custody = host.captureRequestCustody?.();
  expect(custody).toBeDefined();
  expect(captureExecRequestCustodySelection(captured.owners ?? [])(custody)).toBe(true);
  await withExecRequestTurn(
    { identity: { ...identity, runId: "continuation" }, owners: captured.owners },
    async () => {
      const owners = captureExecRequestOwners({ ...identity, runId: "continuation" });
      expect(captureExecRequestCustodySelection(owners ?? [])(custody)).toBe(true);
    },
  );
  await withExecRequestTurn({ identity }, async () => {
    const replacement = captureExecRequestOwners(identity);
    expect(host.captureRequestCustody?.()).toBe(custody);
    expect(captureExecRequestCustodySelection(replacement ?? [])(custody)).toBe(false);
  });
  captured.host.closeHost();
  expect(() => host.captureRequestCustody?.()).toThrow();
  expect(captureExecRequestCustodySelection(captured.owners ?? [])(custody)).toBe(true);
});
