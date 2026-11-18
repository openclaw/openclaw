import { describe, expect, it, vi } from "vitest";
import * as e2eeClient from "../substrate/e2ee-client.js";
import * as faultProxy from "../substrate/fault-proxy.js";
import {
  assertMatrixQaExpectedBootstrapFailure,
  runMatrixQaFaultedRecoveryOwnerVerification,
} from "./scenario-runtime-e2ee-room.js";
import {
  createMatrixQaBootstrapFailure,
  createMatrixQaE2eeTestContext,
} from "./scenario-runtime-e2ee.test-helpers.js";

describe("Matrix E2EE bootstrap fault evidence", () => {
  it("releases the fault proxy when the recovery client cannot start", async () => {
    const failure = new Error("recovery client startup failed");
    const stop = vi.fn(async () => {});
    const proxy = vi.spyOn(faultProxy, "startMatrixQaFaultProxy").mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:19001",
      hits: () => [],
      installRule: vi.fn(),
      setTargetBaseUrl: vi.fn(),
      stop,
    });
    const client = vi
      .spyOn(e2eeClient, "createMatrixQaE2eeScenarioClient")
      .mockRejectedValueOnce(failure);
    try {
      await expect(
        runMatrixQaFaultedRecoveryOwnerVerification({
          accessToken: "synthetic-recovery-token",
          context: createMatrixQaE2eeTestContext(),
          deviceId: "RECOVERY",
          encodedRecoveryKey: "synthetic-recovery-key",
          userId: "@driver:matrix-qa.test",
        }),
      ).rejects.toBe(failure);
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      proxy.mockRestore();
      client.mockRestore();
    }
  });

  it.each([{ methods: [] }, { methods: ["GET"] }])(
    "rejects a history without creation: %j",
    ({ methods }) => {
      expect(() =>
        assertMatrixQaExpectedBootstrapFailure({
          faultHits: methods.map((method) => ({
            method,
            path: "/room_keys/version",
            ruleId: "backup",
          })),
          result: createMatrixQaBootstrapFailure(),
        }),
      ).toThrow("did not attempt faulted room-key backup creation");
    },
  );

  it("requires both creation evidence and the expected failure", () => {
    const faultHits = [{ method: "POST", path: "/room_keys/version", ruleId: "backup" }];
    const result = createMatrixQaBootstrapFailure();
    expect(assertMatrixQaExpectedBootstrapFailure({ faultHits, result })).toBe(result.error);
    expect(() =>
      assertMatrixQaExpectedBootstrapFailure({
        faultHits,
        result: { ...result, success: true },
      }),
    ).toThrow("unexpectedly succeeded");
    expect(() =>
      assertMatrixQaExpectedBootstrapFailure({
        faultHits,
        result: { ...result, error: "unrelated failure" },
      }),
    ).toThrow("unexpected reason");
  });
});
