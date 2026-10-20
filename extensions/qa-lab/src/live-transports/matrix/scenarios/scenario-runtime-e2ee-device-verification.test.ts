import type { MatrixVerificationSummary } from "@openclaw/matrix/test-api.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMatrixQaE2eeScenarioClient,
  type MatrixQaE2eeScenarioClient,
} from "../substrate/e2ee-client.js";
import {
  runMatrixQaE2eeDeviceSasVerificationScenario,
  runMatrixQaE2eeQrVerificationScenario,
} from "./scenario-runtime-e2ee-verification.js";
import {
  createMatrixQaBootstrapFailure,
  createMatrixQaE2eeTestContext,
} from "./scenario-runtime-e2ee.test-helpers.js";

vi.mock("../substrate/e2ee-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../substrate/e2ee-client.js")>()),
  createMatrixQaE2eeScenarioClient: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

const context = () =>
  createMatrixQaE2eeTestContext({
    driverDeviceId: "DRIVER",
    driverPassword: "driver-password",
    observerDeviceId: "OBSERVER",
    observerPassword: "observer-password",
  });

type NativeVerificationClient = Pick<
  MatrixQaE2eeScenarioClient,
  | "bootstrapOwnDeviceVerification"
  | "getRecoveryKey"
  | "stop"
  | "requestVerification"
  | "listVerifications"
  | "acceptVerification"
  | "startVerification"
  | "confirmVerificationSas"
  | "generateVerificationQr"
  | "scanVerificationQr"
  | "confirmVerificationReciprocateQr"
  | "getDeviceVerificationStatus"
>;

function installNativeClients() {
  let phase = "requested";
  let confirmations = 0;
  const bootstrap = createMatrixQaBootstrapFailure();
  bootstrap.success = true;
  bootstrap.error = undefined;
  bootstrap.crossSigning.published = true;
  Object.assign(bootstrap.verification, {
    verified: true,
    signedByOwner: true,
    crossSigningVerified: true,
    recoveryKeyStored: true,
    backupVersion: "1",
  });
  const summary = (actor: "driver" | "observer"): MatrixVerificationSummary => ({
    id: `${actor}-request`,
    transactionId: "transaction-1",
    otherUserId: actor === "driver" ? "@observer:matrix-qa.test" : "@driver:matrix-qa.test",
    otherDeviceId: actor === "driver" ? "OBSERVER" : "DRIVER",
    isSelfVerification: false,
    initiatedByMe: actor === "driver",
    phase: 1,
    phaseName: phase,
    pending: phase !== "done",
    methods: ["m.sas.v1", "m.qr_code.scan.v1"],
    canAccept: phase === "requested",
    hasSas: phase === "sas" || phase === "done",
    sas: { decimal: [123, 456, 789], emoji: [["🐈", "Cat"]] },
    hasReciprocateQr: phase === "reciprocate",
    completed: phase === "done",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  for (const actor of ["driver", "observer"] as const) {
    const advance = (next: string) => {
      phase = next;
      return summary(actor);
    };
    const client: NativeVerificationClient = {
      bootstrapOwnDeviceVerification: async () => bootstrap,
      getRecoveryKey: async () => null,
      stop: async () => undefined,
      requestVerification: async () => summary(actor),
      listVerifications: async () => [
        {
          ...summary(actor),
          id: "unrelated-request",
          transactionId: "unrelated",
          initiatedByMe: true,
        },
        summary(actor),
      ],
      acceptVerification: async () => advance("ready"),
      startVerification: async () => advance("sas"),
      confirmVerificationSas: async () => advance(++confirmations === 2 ? "done" : "sas"),
      generateVerificationQr: async () => ({ qrDataBase64: "AQIDBA==" }),
      scanVerificationQr: async () => advance("reciprocate"),
      confirmVerificationReciprocateQr: async () => advance("done"),
      getDeviceVerificationStatus: async (userId, deviceId) => ({
        encryptionEnabled: true,
        userId: userId ?? null,
        deviceId: deviceId ?? null,
        verified: phase === "done",
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      }),
    };
    // Acquisition-only fixture: the typed Pick implements every native operation
    // these scenarios use; unrelated send/media/deletion operations are omitted.
    vi.mocked(createMatrixQaE2eeScenarioClient, { partial: true }).mockResolvedValueOnce(client);
  }
}

const cases = [
  {
    method: "sas",
    run: runMatrixQaE2eeDeviceSasVerificationScenario,
    label: "device SAS verification",
  },
  { method: "qr", run: runMatrixQaE2eeQrVerificationScenario, label: "QR verification" },
] as const;

describe.each(cases)("Matrix device $method verification", ({ method, run, label }) => {
  it("completes its native protocol and reports exact verification details", async () => {
    installNativeClients();
    const result = await run(context());
    expect(result).toEqual(
      method === "sas"
        ? {
            details:
              "driver-to-observer device verification completed with real SAS\ninitiator transaction: transaction-1\nrecipient transaction: transaction-1\ndriver trusts observer device: yes\nobserver trusts driver device: yes\nemoji: 🐈 Cat",
          }
        : {
            details:
              "driver-to-observer QR verification completed through real QR scan\ntransaction: transaction-1\ndriver trusts observer device: yes\nobserver trusts driver device: yes\nqr bytes: 4",
          },
    );
  });

  it("retains its method-specific missing-device diagnostic", async () => {
    await expect(run({ ...context(), observerDeviceId: undefined })).rejects.toThrow(
      `Matrix E2EE observer device id is required for ${label}`,
    );
  });
});
