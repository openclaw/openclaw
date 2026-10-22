import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runMatrixQaE2eeCliRecoveryKeyInvalidScenario,
  runMatrixQaE2eeCliRecoveryKeySetupScenario,
} from "./scenario-runtime-e2ee-cli-recovery.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  createRuntime: vi.fn(),
  login: vi.fn(),
  ownerActive: false,
  deletedDevices: [] as string[],
}));
vi.mock("../substrate/client.js", () => ({
  createMatrixQaClient: () => ({
    registerWithToken: async () => ({
      accessToken: "owner-test-token",
      deviceId: "OWNER",
      password: "test-password",
      userId: "@owner:matrix-qa.test",
    }),
    loginWithPassword: mocks.login,
  }),
}));
vi.mock("../substrate/e2ee-client.js", () => ({
  createMatrixQaE2eeScenarioClient: async () => {
    mocks.ownerActive = true;
    return {
      stop: async () => {
        mocks.ownerActive = false;
      },
      deleteOwnDevices: async (deviceIds: string[]) => {
        mocks.deletedDevices.push(...deviceIds);
      },
    };
  },
}));
vi.mock("./scenario-runtime-e2ee-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-runtime-e2ee-shared.js")>()),
  ensureMatrixQaE2eeOwnDeviceVerified: mocks.bootstrap,
}));
vi.mock("./scenario-runtime-e2ee-cli-runtime.js", () => ({
  createMatrixQaCliE2eeSetupRuntime: mocks.createRuntime,
}));

const scenarios = [
  { name: "valid recovery key", run: runMatrixQaE2eeCliRecoveryKeySetupScenario },
  { name: "invalid recovery key", run: runMatrixQaE2eeCliRecoveryKeyInvalidScenario },
];

describe.each(scenarios)("Matrix CLI $name setup ownership", ({ run }) => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.ownerActive = false;
    mocks.deletedDevices = [];
    mocks.bootstrap.mockResolvedValue({
      recoveryKey: { encodedPrivateKey: "fixture-recovery-key" },
    });
    mocks.login.mockResolvedValue({
      accessToken: "cli-test-token",
      deviceId: "CLI",
      userId: "@owner:matrix-qa.test",
    });
  });

  it.each(["bootstrap", "login", "runtime"] as const)(
    "releases the owner after %s construction fails and preserves the failure",
    async (step) => {
      const failure = new Error(`${step} construction failed`);
      const rejectingStep = {
        bootstrap: mocks.bootstrap,
        login: mocks.login,
        runtime: mocks.createRuntime,
      }[step];
      rejectingStep.mockRejectedValueOnce(failure);
      await expect(run(createMatrixQaE2eeTestContext())).rejects.toBe(failure);
      expect(mocks.ownerActive).toBe(false);
      expect(mocks.deletedDevices).toEqual(step === "runtime" ? ["CLI"] : []);
    },
  );
});
