import { describe, expect, it } from "vitest";
import {
  buildPairingConnectCloseReason,
  buildPairingConnectErrorDetails,
  buildPairingConnectErrorMessage,
  classifyGatewayConnectFailure,
  ConnectErrorDetailCodes,
  describePairingConnectRequirement,
  formatConnectErrorMessage,
  formatConnectPairingRequiredMessage,
  normalizePairingConnectRequestId,
  readConnectErrorDetailCode,
  readControlUiBuildMismatchId,
  readConnectErrorRecoveryAdvice,
  readConnectPairingRequiredMessage,
  readPairingConnectErrorDetails,
  resolveAuthConnectErrorDetailCode,
} from "./connect-error-details.js";

const expectFormatted = (input: Parameters<typeof formatConnectErrorMessage>[0], message: string) =>
  expect(formatConnectErrorMessage(input)).toBe(message);
const pairingDetails = {
  code: "PAIRING_REQUIRED",
  reason: "scope-upgrade",
  requestId: "req-123",
};
const protocolDetails = {
  code: "PROTOCOL_MISMATCH",
  clientMinProtocol: 5,
  clientMaxProtocol: 5,
  expectedProtocol: 4,
};
const redirect = (location: string) => ({
  details: { reason: "websocket-upgrade-rejected", httpStatus: 302, location },
});

describe("readConnectErrorDetailCode", () => {
  it("reads structured detail codes", () => {
    expect(readConnectErrorDetailCode({ code: "AUTH_TOKEN_MISMATCH" })).toBe("AUTH_TOKEN_MISMATCH");
  });
});

describe("readControlUiBuildMismatchId", () => {
  it("returns a bounded reload target for a Control UI build mismatch", () => {
    expect(
      readControlUiBuildMismatchId({
        code: ConnectErrorDetailCodes.CONTROL_UI_BUILD_MISMATCH,
        gatewayBuildId: "gateway-build",
        reloadRequired: true,
      }),
    ).toBe("gateway-build");
  });

  it.each([
    {},
    {
      code: ConnectErrorDetailCodes.CONTROL_UI_BUILD_MISMATCH,
      gatewayBuildId: "gateway-build",
      reloadRequired: false,
    },
  ])("rejects malformed details", (details) => {
    expect(readControlUiBuildMismatchId(details)).toBeNull();
  });
});

describe("readConnectErrorRecoveryAdvice", () => {
  it("returns empty advice for invalid payloads", () => {
    expect(readConnectErrorRecoveryAdvice(null)).toStrictEqual({});
    expect(readConnectErrorRecoveryAdvice("x")).toStrictEqual({});
    expect(readConnectErrorRecoveryAdvice({ canRetryWithDeviceToken: "yes" })).toEqual({});
    expect(
      readConnectErrorRecoveryAdvice({
        canRetryWithDeviceToken: true,
        recommendedNextStep: "retry_with_magic",
      }),
    ).toEqual({ canRetryWithDeviceToken: true, recommendedNextStep: undefined });
  });
});

describe("classifyGatewayConnectFailure", () => {
  it.each([
    {
      name: "structured pairing upgrade",
      input: {
        details: pairingDetails,
        message: "connect failed",
      },
      kind: "pairing-required",
      message: "scope upgrade pending approval (requestId: req-123)",
      remediation: "openclaw devices approve --latest",
    },
    {
      name: "structured device identity requirement",
      input: { details: { code: "DEVICE_IDENTITY_REQUIRED" }, message: "connect failed" },
      kind: "device-identity-required",
      message: "connect failed",
      remediation: undefined,
    },
    {
      name: "legacy pairing reason",
      input: { reason: "gateway closed (1008): pairing required" },
      kind: "pairing-required",
      message: "gateway closed (1008): pairing required",
      remediation: "openclaw devices approve --latest",
    },
    {
      name: "legacy scope mismatch reason behind a generic message",
      input: { message: "connect failed", reason: "scope mismatch" },
      kind: "scope-mismatch",
      message: "connect failed",
      remediation: "openclaw devices list",
    },
    {
      name: "legacy device token reason behind a generic message",
      input: { message: "connect failed", reason: "device token mismatch" },
      kind: "auth-rejected",
      message: "connect failed",
      remediation: "openclaw devices rotate --device <deviceId> --role operator",
    },
    {
      name: "legacy shared token reason behind a generic message",
      input: { message: "connect failed", reason: "gateway token mismatch" },
      kind: "auth-rejected",
      message: "connect failed",
      remediation: "gateway.remote.token",
    },
    {
      name: "legacy gateway close",
      input: { message: "gateway closed (1008): auth failed" },
      kind: "gateway-rejected",
      message: "gateway closed (1008): auth failed",
      remediation: undefined,
    },
    {
      name: "legacy authentication rate limit",
      input: {
        reason: "unauthorized: too many failed authentication attempts (retry later)",
      },
      kind: "rate-limited",
      message: "unauthorized: too many failed authentication attempts (retry later)",
      remediation: "temporary authentication lockout",
    },
    {
      name: "identity proxy redirect rejection",
      input: {
        details: { reason: "websocket-upgrade-rejected", httpStatus: 302 },
        message: "gateway rejected websocket upgrade (HTTP 302)",
      },
      kind: "identity-proxy",
      message: "gateway rejected websocket upgrade (HTTP 302)",
      remediation: "gateway.remote.edgeAuth",
    },
    {
      name: "unreachable endpoint",
      input: { message: "connect ECONNREFUSED 127.0.0.1:18789" },
      kind: "unreachable",
      message: "connect ECONNREFUSED 127.0.0.1:18789",
      remediation: undefined,
    },
  ])("classifies $name", ({ input, kind, message, remediation }) => {
    const result = classifyGatewayConnectFailure(input);
    expect(result.kind).toBe(kind);
    expect(result.userMessage).toBe(message);
    if (remediation) {
      expect(result.remediation).toContain(remediation);
    } else {
      expect(result.remediation).toBeUndefined();
    }
    if (kind === "pairing-required") {
      expect(result.remediation).toContain("--url");
      expect(result.remediation).toContain("--token/--password");
    }
  });

  it("adds a Cloudflare hint only for Cloudflare Access redirect hosts", () => {
    const cloudflare = classifyGatewayConnectFailure(
      redirect("https://team.cloudflareaccess.com/cdn-cgi/access/login?token=***"),
    );
    const generic = classifyGatewayConnectFailure(redirect("https://login.example/authorize"));

    expect(cloudflare.kind).toBe("identity-proxy");
    expect(cloudflare.kind).not.toBe("unreachable");
    expect(cloudflare.remediation).toContain("Cloudflare Access");
    expect(generic.remediation).not.toContain("Cloudflare");
  });
});

describe("resolveAuthConnectErrorDetailCode", () => {
  it("keeps trusted-proxy identity rejection distinct from generic unauthorized auth", () => {
    expect(
      resolveAuthConnectErrorDetailCode("trusted_proxy_missing_header_cf-access-jwt-assertion"),
    ).toBe("AUTH_IDENTITY_HEADER_REQUIRED");
  });

  it("keeps non-header trusted-proxy rejection generic", () => {
    expect(resolveAuthConnectErrorDetailCode("trusted_proxy_local_interface_check_failed")).toBe(
      "AUTH_UNAUTHORIZED",
    );
  });
});

describe("pairing connect details", () => {
  it("builds reason-specific pairing messages", () => {
    expect(buildPairingConnectErrorMessage("scope-upgrade")).toBe(
      "pairing required: device is asking for more scopes than currently approved",
    );
    expect(describePairingConnectRequirement("not-paired")).toBe("device is not approved yet");
  });

  it("builds structured pairing details with remediation", () => {
    expect(
      buildPairingConnectErrorDetails({
        reason: "not-paired",
        requestId: "req-123",
        recommendedNextStep: "wait_then_retry",
        retryable: true,
        pauseReconnect: false,
      }),
    ).toEqual({
      code: "PAIRING_REQUIRED",
      reason: "not-paired",
      requestId: "req-123",
      remediationHint: "Approve this device from the pending pairing requests.",
      recommendedNextStep: "wait_then_retry",
      retryable: true,
      pauseReconnect: false,
    });
  });

  it("includes request ids in close reasons when available", () => {
    expect(
      buildPairingConnectCloseReason({
        reason: "role-upgrade",
        requestId: "req-789",
      }),
    ).toBe(
      "pairing required: device is asking for a higher role than currently approved (requestId: req-789)",
    );
  });

  it("drops request ids that do not match the allowlist", () => {
    expect(normalizePairingConnectRequestId("req-123")).toBe("req-123");
    expect(normalizePairingConnectRequestId("req-123;rm -rf /")).toBeUndefined();
    expect(
      readPairingConnectErrorDetails({
        ...pairingDetails,
        requestId: "req-123;rm -rf /",
      }),
    ).toEqual({
      code: "PAIRING_REQUIRED",
      reason: "scope-upgrade",
      remediationHint: "Review the requested scopes, then approve the pending upgrade.",
    });
  });

  it("formats upgrade rejections with the request id", () => {
    expect(formatConnectPairingRequiredMessage(pairingDetails)).toBe(
      "scope upgrade pending approval (requestId: req-123)",
    );
  });

  it("parses surfaced pairing-required messages", () => {
    expect(
      readConnectPairingRequiredMessage("scope upgrade pending approval (requestId: req-123)"),
    ).toEqual({
      requestId: "req-123",
      reason: "scope-upgrade",
    });
    expect(
      readConnectPairingRequiredMessage(
        "scope upgrade pending approval (requestId: req-123;rm -rf /)",
      ),
    ).toEqual({
      reason: "scope-upgrade",
    });
  });

  it("formats connect errors when padded detail codes are present", () => {
    expectFormatted(
      {
        message: "pairing required",
        details: {
          ...pairingDetails,
          code: "  PAIRING_REQUIRED  ",
        },
      },
      "scope upgrade pending approval (requestId: req-123)",
    );
    expectFormatted(
      {
        message: "protocol mismatch",
        details: { ...protocolDetails, code: "\tPROTOCOL_MISMATCH\n" },
      },
      "protocol mismatch: Control UI v5, Gateway v4",
    );
  });

  it("formats protocol mismatch details with both client and gateway versions", () => {
    expectFormatted(
      {
        message: "protocol mismatch",
        details: { ...protocolDetails, minimumProbeProtocol: 4 },
      },
      "protocol mismatch: Control UI v5, Gateway v4, connection check min v4",
    );
  });
});
