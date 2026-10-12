import { afterEach, expect, it } from "vitest";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

const cleanup: Array<() => void> = [];

async function createSourceHost(
  operatorAuthority?: AdmittedRunOperatorAuthority,
  abortSignal?: AbortSignal,
  nativeModelPolicySupport?: "exact",
) {
  const host = await createAdmittedHostCapabilityTestFixture(
    { runId: "retained-source", abortSignal },
    { operatorAuthority, nativeModelPolicySupport },
  );
  cleanup.push(host.closeAdmission, host.closeHost);
  return host;
}

function retain(host: Awaited<ReturnType<typeof createSourceHost>>) {
  const retained = host.hostCapabilities.retainSourceAuthority?.();
  if (!retained) {
    throw new Error("expected retained source authority");
  }
  cleanup.push(retained.release);
  return retained;
}

function bindModel(retained: ReturnType<typeof retain>) {
  const binding = retained.bindModelExecution?.({ provider: "fixture", model: "a" });
  if (!binding) {
    throw new Error("expected retained model execution authority");
  }
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
    let revoke = false;
    const source = createAdmittedRunOperatorAuthority({
      profileId: "guest-source",
      scopes: ["operator.write"],
      ...(synchronous ? { signal: controller.signal } : {}),
      assertCurrent: () => {
        if (!current) {
          throw revoked;
        }
        if (revoke) {
          if (revocation === "synchronous signal") {
            controller.abort(new Error("source revoked during validation"));
          } else {
            rotateAgentRunRegistryLifecycleGeneration();
          }
        }
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
      revoke = true;
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
      expect(modelBinding.assertCurrent).toThrow("no longer active");
      expect(() => retained.assertCurrent()).toThrow("no longer active");
      return;
    }
    if (revocation === "source assertion") {
      current = false;
    } else {
      rotateAgentRunRegistryLifecycleGeneration();
      expect(() => source.assertCurrent()).not.toThrow();
    }
    const expected = revocation === "lifecycle rotation" ? "no longer active" : revoked;
    expect(() => retained.assertCurrent()).toThrow(expected);
    expect(modelBinding.assertCurrent).toThrow();
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
  expect(holds).toBe(0);
  expect(listeners.size).toBe(0);
});
