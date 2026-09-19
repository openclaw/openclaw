import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixQaE2eeScenarioClient } from "../substrate/e2ee-client.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

const mocks = vi.hoisted(() => ({
  createMatrixQaClient: vi.fn(),
  ensureMatrixQaE2eeOwnDeviceVerified: vi.fn(),
  requireMatrixQaPassword: vi.fn(() => "driver-password"),
  withMatrixQaE2eeDriver: vi.fn(),
}));

vi.mock("../substrate/client.js", () => ({
  createMatrixQaClient: mocks.createMatrixQaClient,
}));

vi.mock("./scenario-runtime-e2ee-room.js", () => ({
  withMatrixQaE2eeDriver: mocks.withMatrixQaE2eeDriver,
}));

vi.mock("./scenario-runtime-e2ee-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-runtime-e2ee-shared.js")>()),
  ensureMatrixQaE2eeOwnDeviceVerified: mocks.ensureMatrixQaE2eeOwnDeviceVerified,
  requireMatrixQaPassword: mocks.requireMatrixQaPassword,
}));

import { runMatrixQaE2eeStaleDeviceHygieneScenario } from "./scenario-runtime-e2ee-verification.js";

describe("runMatrixQaE2eeStaleDeviceHygieneScenario", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the stale device before the active driver generation is stopped", async () => {
    const order: string[] = [];
    const driver = {
      deleteOwnDevices: vi.fn(async () => {
        order.push("delete");
        return {
          currentDeviceId: "DRIVER",
          deletedDeviceIds: ["SECONDARY"],
          remainingDevices: [{ deviceId: "DRIVER" }],
        };
      }),
      listOwnDevices: vi.fn(async () => {
        order.push("list");
        return [{ deviceId: "DRIVER" }, { deviceId: "SECONDARY" }];
      }),
      stop: vi.fn(async () => {
        order.push("stop");
      }),
    };
    mocks.withMatrixQaE2eeDriver.mockImplementationOnce(
      async (
        _context: MatrixQaScenarioContext,
        _scenarioId: string,
        run: (client: MatrixQaE2eeScenarioClient) => Promise<unknown>,
      ) => await run(driver as unknown as MatrixQaE2eeScenarioClient),
    );
    mocks.createMatrixQaClient.mockReturnValue({
      loginWithPassword: vi.fn(async () => ({ deviceId: "SECONDARY" })),
    });
    const context = {
      baseUrl: "http://127.0.0.1:28123",
      driverUserId: "@driver:matrix-qa.test",
      timeoutMs: 30_000,
    } as MatrixQaScenarioContext;

    const result = await runMatrixQaE2eeStaleDeviceHygieneScenario(context);

    expect(order).toEqual(["list", "delete"]);
    expect(driver.stop).not.toHaveBeenCalled();
    expect(driver.deleteOwnDevices).toHaveBeenCalledWith(["SECONDARY"]);
    expect(result.artifacts).toMatchObject({
      currentDeviceId: "DRIVER",
      deletedDeviceIds: ["SECONDARY"],
      remainingDeviceIds: ["DRIVER"],
      secondaryDeviceId: "SECONDARY",
    });
  });
});
