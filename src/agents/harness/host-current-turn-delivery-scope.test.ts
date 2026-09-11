import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import { captureAgentHarnessCurrentTurnDeliveryAuthority } from "./host-private-capabilities.js";

async function createHost(runId: string) {
  return await createAdmittedHostCapabilityTestFixture({
    agentId: "main",
    runId,
    sessionId: `session-${runId}`,
    sessionKey: `agent:main:${runId}`,
  } as never);
}

describe("agent harness current-turn delivery scope", () => {
  it("restores the outer authority after a nested host scope", async () => {
    const outer = await createHost("outer");
    const inner = await createHost("inner");
    try {
      await outer.runWithHostScope(async () => {
        const outerAuthority = captureAgentHarnessCurrentTurnDeliveryAuthority();
        expect(outerAuthority).toBeDefined();
        await inner.runWithHostScope(async () => {
          expect(captureAgentHarnessCurrentTurnDeliveryAuthority()).not.toBe(outerAuthority);
        });
        expect(captureAgentHarnessCurrentTurnDeliveryAuthority()).toBe(outerAuthority);
      });
    } finally {
      outer.closeHost();
      inner.closeHost();
      outer.closeAdmission();
      inner.closeAdmission();
    }
  });

  it("isolates concurrent hosts and revokes only the closed owner", async () => {
    const first = await createHost("first");
    const second = await createHost("second");
    const entered = createDeferred();
    const release = createDeferred();
    try {
      const firstRun = first.runWithHostScope(async () => {
        const authority = captureAgentHarnessCurrentTurnDeliveryAuthority();
        entered.resolve();
        await release.promise;
        expect(captureAgentHarnessCurrentTurnDeliveryAuthority()).toBe(authority);
        return authority;
      });
      await entered.promise;
      const secondAuthority = await second.runWithHostScope(async () =>
        captureAgentHarnessCurrentTurnDeliveryAuthority(),
      );
      release.resolve();
      const firstAuthority = await firstRun;

      expect(firstAuthority).not.toBe(secondAuthority);
      first.closeHost();
      expect(() => firstAuthority?.assertActive()).toThrow("no longer active");
      expect(() => secondAuthority?.assertActive()).not.toThrow();
    } finally {
      release.resolve();
      first.closeHost();
      second.closeHost();
      first.closeAdmission();
      second.closeAdmission();
    }
  });
});
