import { afterEach, expect, it } from "vitest";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunOperatorAuthority,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

const admissions: PreparedAgentRunAdmission[] = [];
const hosts: Array<ReturnType<typeof createAgentHarnessHostCapabilities>> = [];

async function createSourceHost(
  operatorAuthority?: AdmittedRunOperatorAuthority,
  abortSignal?: AbortSignal,
) {
  const runId = "retained-source";
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "host-capability-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    operatorAuthority,
  });
  admissions.push(admission);
  const admittedRunContext = await admission.admit("plugin-harness", `harness-${runId}`);
  const host = createAgentHarnessHostCapabilities({
    attempt: { runId, admittedRunContext, abortSignal },
    pluginId: "codex",
  });
  hosts.push(host);
  return { admission, host };
}

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.close();
  }
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  resetAgentRunRegistryForTest();
});

it("returns no retained source authority without an operator", async () => {
  const { host } = await createSourceHost();

  expect(host.capabilities.retainSourceAuthority?.()).toBeUndefined();
  host.close();
  expect(() => host.capabilities.retainSourceAuthority?.()).toThrow("no longer active");
});

it("keeps retained source authority until independent native work releases it", async () => {
  let sourceHolds = 0;
  const source = createAdmittedRunOperatorAuthority({
    profileId: "guest-source",
    scopes: ["operator.write"],
    assertCurrent: () => {
      if (sourceHolds === 0) {
        throw new Error("original source was released");
      }
    },
    retain: () => {
      sourceHolds += 1;
      return () => {
        sourceHolds -= 1;
      };
    },
  });
  const { host, admission } = await createSourceHost(source);
  const first = host.capabilities.retainSourceAuthority?.();
  const second = host.capabilities.retainSourceAuthority?.();
  try {
    if (!first || !second) {
      throw new Error("expected independently retained source authority");
    }
    expect(sourceHolds).toBe(3);
    host.close();
    expect(() => host.capabilities.retainSourceAuthority?.()).toThrow("no longer active");
    admission.close();
    expect(sourceHolds).toBe(2);
    expect(() => first.assertCurrent()).not.toThrow();
    expect(() => second.assertCurrent()).not.toThrow();

    first.release();
    first.release();
    expect(sourceHolds).toBe(1);
    expect(() => first.assertCurrent()).toThrow("no longer active");
    expect(() => second.assertCurrent()).not.toThrow();
  } finally {
    first?.release();
    second?.release();
    second?.release();
  }
  expect(sourceHolds).toBe(0);
});

it.each(["source assertion", "source signal", "lifecycle rotation"] as const)(
  "fences retained source authority after foreground completion on %s",
  async (revocation) => {
    let current = true;
    const originalSource = new AbortController();
    const foreground = new AbortController();
    const revoked = new Error("operator access revoked");
    const source = createAdmittedRunOperatorAuthority({
      profileId: "guest-source",
      scopes: ["operator.write"],
      ...(revocation === "source signal" ? { signal: originalSource.signal } : {}),
      assertCurrent: () => {
        if (!current) {
          throw revoked;
        }
      },
    });
    const { host, admission } = await createSourceHost(source, foreground.signal);
    const retained = host.capabilities.retainSourceAuthority?.();
    try {
      if (!retained) {
        throw new Error("expected retained source authority");
      }
      expect(retained.signal?.aborted).toBe(false);
      host.close();
      admission.close();
      foreground.abort();
      expect(() => retained.assertCurrent()).not.toThrow();

      if (revocation === "source signal") {
        originalSource.abort(revoked);
        expect(retained.signal?.aborted).toBe(true);
      } else if (revocation === "source assertion") {
        current = false;
      } else {
        rotateAgentRunRegistryLifecycleGeneration();
        expect(() => source.assertCurrent()).not.toThrow();
      }
      expect(() => retained.assertCurrent()).toThrow(
        revocation === "lifecycle rotation" ? "no longer active" : revoked,
      );
      current = true;
      expect(() => retained.assertCurrent()).toThrow(
        revocation === "source signal" ? revoked : "no longer active",
      );
    } finally {
      retained?.release();
    }
  },
);

it("signals retained work on gateway lifecycle rotation after its foreground closes", async () => {
  const source = createAdmittedRunOperatorAuthority({
    profileId: "guest-source",
    scopes: ["operator.write"],
    assertCurrent: () => {},
  });
  const { host, admission } = await createSourceHost(source);
  const retained = host.capabilities.retainSourceAuthority?.();
  try {
    if (!retained) {
      throw new Error("expected retained source authority");
    }
    host.close();
    admission.close();
    rotateAgentEventLifecycleGeneration();
    expect(retained.signal?.aborted).toBe(true);
    expect(() => retained.assertCurrent()).toThrow("no longer active");
  } finally {
    retained?.release();
  }
});

it.each(["signal", "lifecycle"] as const)(
  "rechecks retained source authority when its assertion revokes %s synchronously",
  async (revocation) => {
    const controller = new AbortController();
    let revoke = false;
    const source = createAdmittedRunOperatorAuthority({
      profileId: "guest-source",
      scopes: ["operator.write"],
      signal: controller.signal,
      assertCurrent: () => {
        if (revoke) {
          if (revocation === "signal") {
            controller.abort(new Error("source revoked during validation"));
          } else {
            rotateAgentRunRegistryLifecycleGeneration();
          }
        }
      },
    });
    const { host, admission } = await createSourceHost(source);
    const retained = host.capabilities.retainSourceAuthority?.();
    try {
      if (!retained) {
        throw new Error("expected retained source authority");
      }
      host.close();
      admission.close();
      revoke = true;
      expect(() => retained.assertCurrent()).toThrow();
    } finally {
      retained?.release();
    }
  },
);
