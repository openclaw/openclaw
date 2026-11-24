import assert from "node:assert/strict";
import { afterEach, expect, it } from "vitest";
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
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { createTestOperatorAuthority } from "../admitted-run-context.test-support.js";
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

it.each([
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
    const source = createTestOperatorAuthority({
      profileId: "guest-source",
      scopes: ["operator.write"],
      ...(synchronous ? { signal: controller.signal } : {}),
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
      if (revocation === "synchronous signal") {
        controller.abort(new Error("source stopped"));
      } else {
        rotateAgentRunRegistryLifecycleGeneration();
      }
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
    if (revocation === "gateway rotation") {
      rotateAgentEventLifecycleGeneration();
      expect(retained.signal?.aborted).toBe(true);
      expect(modelBinding.signal.aborted).toBe(true);
    } else {
      rotateAgentRunRegistryLifecycleGeneration();
    }
    expect(() => retained.assertCurrent()).toThrow("no longer active");
    expect(modelBinding.assertCurrent).toThrow(
      revocation === "gateway rotation" ? "no longer active" : undefined,
    );
    expect(() => retained.assertCurrent()).toThrow("no longer active");
  },
);

it("releases model authority when its retained work closes during acquisition", async () => {
  let sourceHolds = 0;
  const acquisition: { close?: () => void } = {};
  const source = createTestOperatorAuthority({
    profileId: "guest-source",
    scopes: ["operator.write"],
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
