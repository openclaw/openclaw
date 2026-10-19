import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import type { MatrixVerificationSummary } from "@openclaw/matrix/test-api.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMatrixQaE2eeScenarioClient,
  type MatrixQaE2eeScenarioClient,
} from "../substrate/e2ee-client.js";
import {
  waitForMatrixQaVerificationSummary,
  withMatrixQaE2eeDriverAndObserver,
} from "./scenario-runtime-e2ee-shared.js";
import { createMatrixQaE2eeTestContext } from "./scenario-runtime-e2ee.test-helpers.js";

vi.mock("../substrate/e2ee-client.js", () => ({
  createMatrixQaE2eeScenarioClient: vi.fn(),
  runMatrixQaE2eeBootstrap: vi.fn(),
}));

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function summary(overrides: Partial<MatrixVerificationSummary> = {}): MatrixVerificationSummary {
  return {
    id: "private-id",
    transactionId: "private-transaction",
    roomId: "private-room",
    otherUserId: "private-user",
    otherDeviceId: "private-device",
    isSelfVerification: true,
    initiatedByMe: false,
    phase: 1,
    phaseName: "requested",
    pending: true,
    methods: ["private-method"],
    canAccept: true,
    hasSas: true,
    sas: { decimal: [123, 456, 789], emoji: [["secret-emoji", "secret-label"]] },
    hasReciprocateQr: true,
    completed: false,
    error: "private-raw-error",
    createdAt: "private-created",
    updatedAt: "private-updated",
    ...overrides,
  };
}

const context = createMatrixQaE2eeTestContext();
const scenarioId = "matrix-e2ee-qr-verification";
const client = (stop: MatrixQaE2eeScenarioClient["stop"]) =>
  ({ stop }) as MatrixQaE2eeScenarioClient;
function acquire(driver: MatrixQaE2eeScenarioClient, observer: MatrixQaE2eeScenarioClient) {
  vi.mocked(createMatrixQaE2eeScenarioClient)
    .mockResolvedValueOnce(driver)
    .mockResolvedValueOnce(observer);
}
const runScenario = (exercise: Parameters<typeof withMatrixQaE2eeDriverAndObserver>[2]) =>
  withMatrixQaE2eeDriverAndObserver(context, scenarioId, exercise);

it("stops the driver and preserves cleanup failure when observer acquisition fails", async () => {
  const acquisitionFailure = new Error("observer startup failed");
  const cleanupFailure = new Error("driver persistence failed");
  const stop = vi.fn().mockRejectedValue(cleanupFailure);
  vi.mocked(createMatrixQaE2eeScenarioClient)
    .mockResolvedValueOnce(client(stop))
    .mockRejectedValueOnce(acquisitionFailure);
  const run = vi.fn();
  await expect(runScenario(run)).rejects.toMatchObject({
    cause: acquisitionFailure,
    errors: [acquisitionFailure, cleanupFailure],
  });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
});

it.each([true, false])("joins both cleanups (scenario also fails: %s)", async (scenarioFails) => {
  const scenarioFailure = new Error("verification failed");
  const driverFailure = scenarioFails ? new Error("driver shutdown failed") : undefined;
  const observerFailure = new Error("observer shutdown failed");
  const failures = [scenarioFailure, driverFailure, observerFailure];
  const delayedStop = createDeferred<void>();
  const earlyStop = vi.fn().mockRejectedValue(scenarioFails ? observerFailure : undefined);
  const lateStop = vi.fn(async () => {
    await delayedStop.promise;
    return scenarioFails ? Promise.reject(driverFailure) : undefined;
  });
  const [driverStop, observerStop] = scenarioFails ? [lateStop, earlyStop] : [earlyStop, lateStop];
  acquire(client(driverStop), client(observerStop));
  const resolved = vi.fn();
  const rejected = vi.fn();
  const completion = runScenario(async () => {
    if (scenarioFails) {
      throw scenarioFailure;
    }
    return { verified: true };
  }).then(resolved, rejected);
  try {
    await setImmediate();
    expect(driverStop).toHaveBeenCalledTimes(1);
    expect(observerStop).toHaveBeenCalledTimes(1);
    expect(resolved).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
  } finally {
    delayedStop.resolve();
    await completion;
  }
  expect(resolved).not.toHaveBeenCalled();
  expect(rejected).toHaveBeenCalledExactlyOnceWith(
    scenarioFails
      ? expect.objectContaining({ cause: scenarioFailure, errors: failures })
      : undefined,
  );
});

it("returns the scenario result after stopping both clients", async () => {
  const stopDriver = vi.fn(async () => {});
  const stopObserver = vi.fn(async () => {});
  const driver = client(stopDriver);
  const observer = client(stopObserver);
  acquire(driver, observer);
  const result = { verified: true };
  const run = vi.fn(async () => result);

  await expect(withMatrixQaE2eeDriverAndObserver(context, scenarioId, run)).resolves.toBe(result);
  expect(run).toHaveBeenCalledExactlyOnceWith({ driver, observer });
  expect(stopDriver).toHaveBeenCalledTimes(1);
  expect(stopObserver).toHaveBeenCalledTimes(1);
});
describe("Matrix verification wait diagnostics", () => {
  const listVerifications = vi.fn<MatrixQaE2eeScenarioClient["listVerifications"]>();
  const verificationClient = { listVerifications } as MatrixQaE2eeScenarioClient;
  const wait = (
    predicate: (entry: MatrixVerificationSummary) => boolean,
    label = "complete",
    timeoutMs = 1_000,
  ) =>
    waitForMatrixQaVerificationSummary({ client: verificationClient, predicate, label, timeoutMs });
  beforeEach(() => void vi.spyOn(process.stderr, "write").mockReturnValue(true));
  it("reports only four latest phase/boolean states at the unchanged polling deadline", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(sleep).mockImplementation(async (ms) => {
      now += ms ?? 0;
    });
    const latest = Array.from({ length: 6 }, () => summary({ phaseName: "ready" }));
    listVerifications.mockResolvedValueOnce([summary()]).mockResolvedValue(latest);
    const predicate = vi.fn(() => false);
    const expected = Array.from({ length: 4 }, () => ({
      phase: "ready",
      pending: true,
      completed: false,
      initiatedByMe: false,
      hasReciprocateQr: true,
      hasSas: true,
      hasError: true,
    }));
    const message = `timed out waiting for Matrix verification summary: recipient ready; states=${JSON.stringify(expected)}`;
    await expect(wait(predicate, "recipient ready", 275)).rejects.toStrictEqual(new Error(message));
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(
      `[matrix-verification-timeout] ${message}\n`,
    );
    expect(listVerifications).toHaveBeenCalledTimes(2);
    expect(predicate).toHaveBeenCalledTimes(7);
    expect(vi.mocked(sleep).mock.calls.map(([ms]) => ms)).toEqual([250, 25]);
    expect(now).toBe(275);
  });

  it("returns the matching summary unchanged without timeout diagnostics", async () => {
    const expected = summary({ completed: true, phaseName: "done" });
    listVerifications.mockResolvedValue([summary(), expected]);
    await expect(wait((entry) => entry.completed)).resolves.toBe(expected);
    expect(sleep).not.toHaveBeenCalled();
    expect(process.stderr.write).not.toHaveBeenCalled();
  });
});
