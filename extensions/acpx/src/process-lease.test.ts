import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { createAcpxProcessLeaseStore, type AcpxProcessLease } from "./process-lease.js";

function makeLease(index: number): AcpxProcessLease {
  return {
    leaseId: `lease-${index}`,
    gatewayInstanceId: "gateway-test",
    sessionKey: `agent:codex:acp:${index}`,
    wrapperRoot: "/tmp/openclaw/acpx",
    wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
    rootPid: 1000 + index,
    commandHash: `hash-${index}`,
    startedAt: index,
    state: "open",
  };
}

describe("createAcpxProcessLeaseStore", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it("serializes concurrent lease saves without dropping records", async () => {
    await withOpenClawTestState({ label: "acpx-leases" }, async ({ stateDir }) => {
      const store = createAcpxProcessLeaseStore({ stateDir });
      await Promise.all(Array.from({ length: 25 }, (_, index) => store.save(makeLease(index))));

      const leases = await store.listOpen("gateway-test");
      expect(leases.map((lease) => lease.leaseId).toSorted()).toEqual(
        Array.from({ length: 25 }, (_, index) => `lease-${index}`).toSorted(),
      );
    });
  });
});
