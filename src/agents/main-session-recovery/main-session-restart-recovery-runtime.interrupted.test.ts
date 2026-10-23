import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ discover: vi.fn(async () => []) }));

vi.mock("./main-session-restart-recovery-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./main-session-restart-recovery-shared.js")>()),
  discoverRestartRecoveryStoreTargets: mocks.discover,
}));

import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery-runtime.js";

it("discovers persisted interrupted checkpoints for recovery", async () => {
  const gatewayRuntime = createRecoveryRuntimeFixture({
    callGateway: vi.fn(async () => {
      throw new Error("unexpected dispatch");
    }),
    getDispatchSettlement: async () => {},
    sendRecoveryNotice: async () => ({ suppressed: false }),
  });

  await expect(recoverRestartAbortedMainSessions({ gatewayRuntime })).resolves.toEqual({
    started: 0,
    settled: 0,
    failed: 0,
    skipped: 0,
  });
  expect(mocks.discover).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ statuses: ["running", "interrupted"] }),
  );
});
