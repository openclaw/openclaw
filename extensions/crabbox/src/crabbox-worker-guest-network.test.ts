import fs from "node:fs";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it } from "vitest";
import {
  readGuestNetworkExpectation,
  verifyGuestAcquisition,
  verifyGuestInspect,
} from "./crabbox-worker-guest-network.js";
const fixture: unknown = JSON.parse(
  fs.readFileSync(
    new URL("./testdata/guest-network-caller-contract.json", import.meta.url),
    "utf8",
  ),
);
if (!isRecord(fixture)) {
  throw new Error("invalid delivered fixture");
}
it("binds the actual direct caller fixture at acquisition and inspection", () => {
  const expected = readGuestNetworkExpectation(fixture.directConfig);
  const binding = {
    expected,
    acquisition: verifyGuestAcquisition(
      fixture.acquisitionTiming,
      { expected },
      "cbx_0123456789ab",
      "aws",
    ),
  };
  expect(verifyGuestInspect(fixture.inspect, binding, "cbx_0123456789ab", "aws").boundaryId).toBe(
    "sg-11111111",
  );
});
it("does not admit an advertisement or unqualified managed config", () => {
  expect(() => readGuestNetworkExpectation(fixture.discovery)).toThrow();
  expect(() => readGuestNetworkExpectation(fixture.managedCoordinatorConfig)).toThrow();
});
it("binds managed public bootstrap facts from the authenticated server fixture", () => {
  if (
    !isRecord(fixture.managedServerCapability) ||
    !isRecord(fixture.managedAcquisitionResponse) ||
    !isRecord(fixture.managedAcquisitionResponse.lease) ||
    !isRecord(fixture.managedInspectResponse) ||
    !isRecord(fixture.managedInspectResponse.lease)
  ) {
    throw new Error("missing delivered managed vector");
  }
  const expected = readGuestNetworkExpectation({
    provider: "aws",
    guestNetworkCapability: {
      version: 1,
      state: "implemented",
      allocationRoute: "managed-coordinator",
    },
    guestNetworkPolicy: fixture.managedServerCapability.policy,
  });
  const lease = fixture.managedAcquisitionResponse.lease;
  const binding = {
    expected,
    acquisition: verifyGuestAcquisition(
      { provider: "aws", leaseId: lease.id, exitCode: 0, guestNetwork: lease.guestNetwork },
      { expected },
      "cbx_0123456789ab",
      "aws",
    ),
  };
  const inspected = fixture.managedInspectResponse.lease;
  expect(
    verifyGuestInspect(
      {
        id: inspected.id,
        provider: inspected.provider,
        providerResourceId: inspected.cloudID,
        guestNetwork: inspected.guestNetwork,
      },
      binding,
      "cbx_0123456789ab",
      "aws",
    ).facts.imds,
  ).toBe("roleless-v2");
});
it.each(["leaseId", "provider", "resourceId", "boundaryId", "policyDigest", "bootstrapMode"])(
  "rejects substituted %s",
  (field) => {
    const expected = readGuestNetworkExpectation(fixture.directConfig);
    if (!isRecord(fixture.acquisitionTiming) || !isRecord(fixture.acquisitionTiming.guestNetwork)) {
      throw new Error("invalid fixture");
    }
    const modified = {
      ...fixture.acquisitionTiming,
      guestNetwork: { ...fixture.acquisitionTiming.guestNetwork, [field]: "foreign" },
    };
    expect(() =>
      verifyGuestAcquisition(modified, { expected }, "cbx_0123456789ab", "aws"),
    ).toThrow();
  },
);
it("rejects missing acquisition, unknown enforcement facts and changed boundaries at inspect", () => {
  const expected = readGuestNetworkExpectation(fixture.directConfig);
  expect(() =>
    verifyGuestInspect(fixture.inspect, { expected }, "cbx_0123456789ab", "aws"),
  ).toThrow("acquisition");
  const acquisition = verifyGuestAcquisition(
    fixture.acquisitionTiming,
    { expected },
    "cbx_0123456789ab",
    "aws",
  );
  if (!isRecord(fixture.inspect)) {
    throw new Error("invalid inspect");
  }
  const inspected = fixture.inspect;
  for (const guestNetwork of [
    { ...acquisition, boundaryId: "sg-22222222" },
    { ...acquisition, facts: { ...acquisition.facts, newException: "unknown" } },
  ]) {
    expect(() =>
      verifyGuestInspect(
        { ...inspected, guestNetwork },
        { expected, acquisition },
        "cbx_0123456789ab",
        "aws",
      ),
    ).toThrow();
  }
});
