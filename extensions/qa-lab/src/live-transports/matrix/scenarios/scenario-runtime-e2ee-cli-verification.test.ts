import { afterEach, expect, it, vi } from "vitest";
import type { MatrixQaCliRunResult } from "./scenario-runtime-cli.js";
import { runMatrixQaE2eeCliSelfVerificationScenario } from "./scenario-runtime-e2ee-cli-verification.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  kill: vi.fn(),
  wait: vi.fn(),
  waitForOutput: vi.fn(),
  deleteOwnDevices: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("./scenario-runtime-e2ee-cli-runtime.js", () => ({
  createMatrixQaCliSelfVerificationRuntime: async () => ({
    rootDir: "/synthetic-matrix-cli",
    dispose: mocks.dispose,
    start: () => ({
      kill: mocks.kill,
      wait: mocks.wait,
      waitForOutput: mocks.waitForOutput,
    }),
  }),
}));
vi.mock("./scenario-runtime-e2ee-cli-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-runtime-e2ee-cli-shared.js")>()),
  registerMatrixQaCliE2eeAccount: async () => ({ userId: "@owner:matrix-qa.test" }),
  createMatrixQaE2eeCliOwnerClient: async () => ({
    stop: mocks.stop,
    deleteOwnDevices: mocks.deleteOwnDevices,
  }),
  loginMatrixQaCliDevice: async () => ({
    accessToken: "synthetic-token",
    deviceId: "CLI",
    userId: "@owner:matrix-qa.test",
  }),
  runMatrixQaSetupCliJson: async () => ({
    artifacts: {},
    payload: {
      success: true,
      backup: { decryptionKeyCached: true, matchesDecryptionKey: true },
    },
  }),
}));
vi.mock("./scenario-runtime-e2ee-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-runtime-e2ee-shared.js")>()),
  ensureMatrixQaE2eeOwnDeviceVerified: async () => ({
    recoveryKey: { encodedPrivateKey: "synthetic-recovery-key" },
  }),
}));

afterEach(() => vi.resetAllMocks());

it("settles the interactive CLI before removing its state and device after verification fails", async () => {
  const killed = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<MatrixQaCliRunResult>();
  const failure = new Error("verification guidance was not received");
  mocks.dispose.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.deleteOwnDevices.mockResolvedValue(undefined);
  mocks.kill.mockImplementation(() => killed.resolve());
  mocks.wait.mockReturnValue(settled.promise);
  mocks.waitForOutput.mockRejectedValue(failure);

  const result = runMatrixQaE2eeCliSelfVerificationScenario(createMatrixQaE2eeTestContext()).catch(
    (error: unknown) => error,
  );
  await killed.promise;
  try {
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(mocks.deleteOwnDevices).not.toHaveBeenCalled();
  } finally {
    settled.resolve({ args: [], exitCode: 1, stdout: "", stderr: "" });
    await result;
  }
  expect(await result).toBe(failure);
  expect(mocks.dispose).toHaveBeenCalledOnce();
  expect(mocks.deleteOwnDevices).toHaveBeenCalledExactlyOnceWith(["CLI"]);
});
