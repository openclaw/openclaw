import { describe, expect, it } from "vitest";
import { inspectTlsCertificateError } from "./tls-certificate-errors.js";

const CERTIFICATE_INVALID_CODES = [
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
];

describe("inspectTlsCertificateError", () => {
  it.each(CERTIFICATE_INVALID_CODES)("classifies Node/OpenSSL certificate code %s", (code) => {
    expect(inspectTlsCertificateError({ code, message: "TLS validation failed" })).toEqual({
      kind: "certificate_invalid",
      code,
      message: "TLS validation failed",
    });
  });

  it.each(["ERR_TLS_CERT_ALTNAME_INVALID", "HOSTNAME_MISMATCH"])(
    "classifies hostname mismatch code %s",
    (code) => {
      expect(inspectTlsCertificateError({ code, message: "TLS validation failed" })).toEqual({
        kind: "hostname_mismatch",
        code,
        message: "TLS validation failed",
      });
    },
  );

  it("walks nested causes and preserves the matching details", () => {
    const cause = Object.assign(new Error("certificate has expired"), {
      code: "CERT_HAS_EXPIRED",
    });
    expect(inspectTlsCertificateError(new TypeError("fetch failed", { cause }))).toEqual({
      kind: "certificate_invalid",
      code: "CERT_HAS_EXPIRED",
      message: "certificate has expired",
    });
  });

  it("walks AggregateError members", () => {
    const certificateError = Object.assign(new Error("certificate revoked"), {
      code: "CERT_REVOKED",
    });
    const error = new AggregateError(
      [new Error("connection failed"), certificateError],
      "request failed",
    );

    expect(inspectTlsCertificateError(error)).toEqual({
      kind: "certificate_invalid",
      code: "CERT_REVOKED",
      message: "certificate revoked",
    });
  });

  it("handles cycles without recursing forever", () => {
    const error: { cause?: unknown; message: string } = { message: "fetch failed" };
    error.cause = error;
    expect(inspectTlsCertificateError(error)).toBeNull();
  });

  it.each([
    ["certificate is not yet valid", "certificate_invalid"],
    ["self-signed certificate in certificate chain", "certificate_invalid"],
    [
      "Hostname/IP does not match certificate's altnames: Host: api.example.com",
      "hostname_mismatch",
    ],
  ] as const)("classifies message-only failure %s", (message, kind) => {
    expect(inspectTlsCertificateError(message)).toEqual({ kind, message });
  });

  it.each([
    Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    new Error("Client network socket disconnected before secure TLS connection was established"),
    { code: "OUT_OF_MEM", message: "out of memory" },
  ])("does not classify transient or non-certificate failure", (error) => {
    expect(inspectTlsCertificateError(error)).toBeNull();
  });
});
