import { expect, it } from "vitest";
import {
  buildPairingConnectCloseReason as closeReason,
  buildPairingConnectErrorDetails as buildDetails,
  buildPairingConnectErrorMessage as pairingMessage,
  classifyGatewayConnectFailure as classify,
  ConnectErrorDetailCodes,
  describePairingConnectRequirement as requirement,
  formatConnectErrorMessage as formatError,
  normalizePairingConnectRequestId as requestId,
  readControlUiBuildMismatchId as buildMismatchId,
  readConnectErrorRecoveryAdvice as recoveryAdvice,
  readConnectPairingRequiredMessage as readPairingMessage,
  readPairingConnectErrorDetails as readPairingDetails,
  resolveAuthConnectErrorDetailCode as authCode,
} from "./connect-error-details.js";

const pairingDetails = { code: "PAIRING_REQUIRED", reason: "scope-upgrade", requestId: "req-123" };
const protocolDetails = {
  code: "PROTOCOL_MISMATCH",
  clientMinProtocol: 5,
  clientMaxProtocol: 5,
  expectedProtocol: 4,
};
const redirect = (location: string) => ({
  details: { reason: "websocket-upgrade-rejected", httpStatus: 302, location },
});

it("returns a bounded reload target for a Control UI build mismatch", () => {
  expect(
    buildMismatchId({
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
  expect(buildMismatchId(details)).toBeNull();
});

it("returns empty advice for invalid payloads", () => {
  expect(recoveryAdvice(null)).toStrictEqual({});
  expect(recoveryAdvice("x")).toStrictEqual({});
  expect(recoveryAdvice({ canRetryWithDeviceToken: "yes" })).toEqual({});
  expect(
    recoveryAdvice({ canRetryWithDeviceToken: true, recommendedNextStep: "retry_with_magic" }),
  ).toEqual({ canRetryWithDeviceToken: true, recommendedNextStep: undefined });
});

const failed = (reason: string) => ({ message: "connect failed", reason });
const failure = (
  kind: string,
  input: Parameters<typeof classify>[0],
  remediation?: string,
  message = input.message ?? input.reason,
) => ({ kind, input, remediation, message });

it.each([
  failure(
    "pairing-required",
    { details: pairingDetails, message: "connect failed" },
    "openclaw devices approve --latest",
    "scope upgrade pending approval (requestId: req-123)",
  ),
  failure("device-identity-required", {
    details: { code: "DEVICE_IDENTITY_REQUIRED" },
    message: "connect failed",
  }),
  failure(
    "pairing-required",
    { reason: "gateway closed (1008): pairing required" },
    "openclaw devices approve --latest",
  ),
  failure("scope-mismatch", failed("scope mismatch"), "openclaw devices list"),
  failure(
    "auth-rejected",
    failed("device token mismatch"),
    "openclaw devices rotate --device <deviceId> --role operator",
  ),
  failure("auth-rejected", failed("gateway token mismatch"), "gateway.remote.token"),
  failure("gateway-rejected", { message: "gateway closed (1008): auth failed" }),
  failure(
    "rate-limited",
    { reason: "unauthorized: too many failed authentication attempts (retry later)" },
    "temporary authentication lockout",
  ),
  failure(
    "identity-proxy",
    {
      details: { reason: "websocket-upgrade-rejected", httpStatus: 302 },
      message: "gateway rejected websocket upgrade (HTTP 302)",
    },
    "gateway.remote.edgeAuth",
  ),
  failure("unreachable", { message: "connect ECONNREFUSED 127.0.0.1:18789" }),
])("classifies $input as $kind", ({ input, kind, message, remediation }) => {
  const result = classify(input);
  expect({ kind: result.kind, message: result.userMessage }).toEqual({ kind, message });
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
  const cloudflare = classify(
    redirect("https://team.cloudflareaccess.com/cdn-cgi/access/login?token=***"),
  );
  const generic = classify(redirect("https://login.example/authorize"));

  expect(cloudflare.kind).toBe("identity-proxy");
  expect(cloudflare.remediation).toContain("Cloudflare Access");
  expect(generic.remediation).not.toContain("Cloudflare");
});

it.each([
  ["missing_header_cf-access-jwt-assertion", "AUTH_IDENTITY_HEADER_REQUIRED"],
  ["local_interface_check_failed", "AUTH_UNAUTHORIZED"],
])("maps trusted-proxy rejection %s to %s", (reason, expected) => {
  expect(authCode(`trusted_proxy_${reason}`)).toBe(expected);
});

it("builds reason-specific pairing messages", () => {
  expect(pairingMessage("scope-upgrade")).toBe(
    "pairing required: device is asking for more scopes than currently approved",
  );
  expect(requirement("not-paired")).toBe("device is not approved yet");
});

it("builds structured pairing details with remediation", () => {
  const input = {
    reason: "not-paired",
    requestId: "req-123",
    recommendedNextStep: "wait_then_retry",
    retryable: true,
    pauseReconnect: false,
  } as const;
  expect(buildDetails(input)).toEqual({
    ...input,
    code: "PAIRING_REQUIRED",
    remediationHint: "Approve this device from the pending pairing requests.",
  });
});

it("includes request ids in close reasons when available", () => {
  expect(closeReason({ reason: "role-upgrade", requestId: "req-789" })).toBe(
    "pairing required: device is asking for a higher role than currently approved (requestId: req-789)",
  );
});

it("drops request ids that do not match the allowlist", () => {
  expect(requestId("req-123")).toBe("req-123");
  expect(requestId("req-123;rm -rf /")).toBeUndefined();
  expect(readPairingDetails({ ...pairingDetails, requestId: "req-123;rm -rf /" })).toEqual({
    code: "PAIRING_REQUIRED",
    reason: "scope-upgrade",
    remediationHint: "Review the requested scopes, then approve the pending upgrade.",
  });
});

it("parses surfaced pairing-required messages", () => {
  expect(readPairingMessage("scope upgrade pending approval (requestId: req-123)")).toEqual({
    requestId: "req-123",
    reason: "scope-upgrade",
  });
  expect(
    readPairingMessage("scope upgrade pending approval (requestId: req-123;rm -rf /)"),
  ).toEqual({ reason: "scope-upgrade" });
});

it.each([
  [
    { message: "pairing required", details: { ...pairingDetails, code: "  PAIRING_REQUIRED  " } },
    "scope upgrade pending approval (requestId: req-123)",
  ],
  [
    {
      message: "protocol mismatch",
      details: { ...protocolDetails, code: "\tPROTOCOL_MISMATCH\n" },
    },
    "protocol mismatch: Control UI v5, Gateway v4",
  ],
  [
    { message: "protocol mismatch", details: { ...protocolDetails, minimumProbeProtocol: 4 } },
    "protocol mismatch: Control UI v5, Gateway v4, connection check min v4",
  ],
])("formats structured and padded connect details %j", (input, message) => {
  expect(formatError(input)).toBe(message);
});
