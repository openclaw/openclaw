import { afterEach, assert, describe, expect, it } from "vitest";
import { configureAcpErrorRedactor } from "../error-format.js";
import {
  AcpRuntimeError,
  formatAcpErrorChain,
  isAcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "./errors.js";

const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
const credentials = [
  "Authorization: Basic dXNlcjpwYXNzd29yZGFiY2RlZg==",
  "-----BEGIN PRIVATE KEY-----\nabcdefghijklmnopqrstuvwxyz\n-----END PRIVATE KEY-----",
];
const rejection = `upstream rejected token=${token}`;
const fallback = { fallbackCode: "ACP_TURN_FAILED", fallbackMessage: "fallback" } as const;

function rejectThroughBoundary(error: unknown) {
  return withAcpRuntimeErrorBoundary({
    run: async () => {
      throw error;
    },
    ...fallback,
  });
}

afterEach(() => configureAcpErrorRedactor(undefined));

describe("ACP runtime errors", () => {
  it.each([undefined, "ACP_BACKEND_MISSING"])("wraps errors with source code %s", async (code) => {
    const source = Object.assign(new Error("boom"), { code, data: { details: "detail" } });
    const promise = rejectThroughBoundary(source);
    await expect(promise).rejects.toMatchObject({
      name: "AcpRuntimeError",
      code: code ?? "ACP_TURN_FAILED",
      message: "boom",
    });
    const error = await promise.catch((caught: unknown) => caught);
    assert(error instanceof AcpRuntimeError);
    expect(error.cause).toBe(source);
    if (code) {
      expect(isAcpRuntimeError(source)).toBe(true);
    }
  });

  it.each([
    [Object.assign([], { details: "array diagnostic" }), "boom: array diagnostic"],
    [{ details: false }, "boom: false"],
    [42, "boom"],
    [null, "boom"],
    [Object.assign(() => {}, { details: "not an object" }), "boom"],
    [
      { details: `unknown config option: timeout; token=${token}` },
      "boom: unknown config option: timeout; token=[REDACTED]",
    ],
  ])("reads numeric request details from object-backed data: %j", (data, message) => {
    const source = Object.assign(new Error("boom"), { name: "RequestError", code: -32603, data });
    const error = toAcpRuntimeError({ error: source, ...fallback });
    expect(error).toMatchObject({ code: "ACP_TURN_FAILED", message });
    expect(error.message).not.toContain(token);
    expect(error.cause).toBe(source);
  });

  it("passes through existing ACP runtime errors", async () => {
    const existing = new AcpRuntimeError("ACP_BACKEND_MISSING", "backend missing");
    await expect(rejectThroughBoundary(existing)).rejects.toBe(existing);
  });
  it("retains numeric codes and a non-Error false cause in order", () => {
    const request = Object.assign(new Error("request failed", { cause: false }), {
      name: "RequestError",
      code: -32603,
    });
    expect(
      formatAcpErrorChain(new AcpRuntimeError("ACP_TURN_FAILED", "outer", { cause: request })),
    ).toBe(
      "AcpRuntimeError [ACP_TURN_FAILED]: outer <- RequestError [-32603]: request failed <- false",
    );
  });

  it.each([
    [rejection, /upstream rejected/],
    [
      new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn failed", { cause: new Error(rejection) }),
      /ACP_TURN_FAILED.*upstream rejected/,
    ],
    [
      new AcpRuntimeError("ACP_TURN_FAILED", `backend failed: ${credentials.join(" ")}`),
      /backend failed/,
    ],
  ])("redacts credentials while preserving diagnostics: %s", (source, diagnostic) => {
    const out = formatAcpErrorChain(source);
    expect(out).toMatch(diagnostic);
    for (const secret of [token, ...credentials]) {
      expect(out).not.toContain(secret);
    }
  });

  it("uses a configured host redactor before rendering ACP error text", () => {
    configureAcpErrorRedactor((value) => value.replaceAll("custom-secret", "[CUSTOM]"));
    const out = formatAcpErrorChain(new AcpRuntimeError("ACP_TURN_FAILED", "custom-secret"));
    expect(out).toContain("[CUSTOM]");
    expect(out).not.toContain("custom-secret");
  });
});
