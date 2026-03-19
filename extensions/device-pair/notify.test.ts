import { describe, expect, it } from "vitest";
import { formatPendingRequests, type PendingPairingRequest } from "./notify.ts";

describe("device-pair notify pending formatting", () => {
  it("includes role and scopes for pending requests", () => {
    const pending: PendingPairingRequest[] = [
      {
        requestId: "req-1",
        deviceId: "device-1",
        displayName: "dev one",
        platform: "ios",
        role: "operator",
        scopes: ["operator.admin", "operator.read"],
        remoteIp: "198.51.100.2",
      },
    ];

    const text = formatPendingRequests(pending);
    expect(text).toContain("Pending device pairing requests:");
    expect(text).toContain("name=dev one");
    expect(text).toContain("platform=ios");
    expect(text).toContain("role=operator");
    expect(text).toContain("scopes=operator.admin, operator.read");
    expect(text).toContain("ip=198.51.100.2");
  });

  it("falls back to roles list and no scopes when role/scopes are absent", () => {
    const pending: PendingPairingRequest[] = [
      {
        requestId: "req-2",
        deviceId: "device-2",
        roles: ["node", "operator"],
        scopes: [],
      },
    ];

    const text = formatPendingRequests(pending);
    expect(text).toContain("role=node, operator");
    expect(text).toContain("scopes=none");
  });
});
