import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  attachLocalServiceDiagnostics,
  captureLocalServiceOutput,
  createLocalServiceLease,
  getLocalServiceDiagnosticTail,
} from "./provider-local-service-diagnostics.js";

describe("local service diagnostic egress", () => {
  it.each(["Error", "TimeoutError"])(
    "redacts reused leases and preserves %s identity across replacement",
    (kind) => {
      const first = { healthUrl: "http://127.0.0.1/health", stderrTail: "" };
      const stderr = new PassThrough();
      captureLocalServiceOutput({ stderr }, first, { command: "/synthetic/server" }, undefined);
      const original = createLocalServiceLease(() => {}, first, {
        "x-local-key": "synthetic-first",
      });
      const reused = createLocalServiceLease(() => {}, first, {
        "x-local-key": "synthetic-second",
      });
      stderr.write("old-child: synthetic-second\n");
      const error = Object.assign(
        kind === "Error"
          ? new Error("HTTP 500")
          : new DOMException("request timed out", "TimeoutError"),
        { status: 500 },
      );
      expect(attachLocalServiceDiagnostics(error, reused)).toBe(error);
      expect(error.status).toBe(500);
      expect(error.message).toContain("old-child");
      expect(error.message).not.toContain("synthetic-second");

      const second = { healthUrl: first.healthUrl, stderrTail: "" };
      const replacementStderr = new PassThrough();
      captureLocalServiceOutput(
        { stderr: replacementStderr },
        second,
        { command: "/synthetic/server" },
        undefined,
      );
      const replacement = createLocalServiceLease(() => {}, second);
      replacementStderr.write("replacement-child\n");
      expect(getLocalServiceDiagnosticTail(original)).toContain("old-child");
      expect(getLocalServiceDiagnosticTail(original)).not.toContain("synthetic-second");
      expect(getLocalServiceDiagnosticTail(original)).not.toContain("replacement-child");
      expect(getLocalServiceDiagnosticTail(replacement)).not.toContain("old-child");
      expect(getLocalServiceDiagnosticTail(replacement)).toContain("replacement-child");
      stderr.end();
      replacementStderr.end();
    },
  );

  it("redacts retained lines of a multiline secret after the line limit", () => {
    const diagnostics = { healthUrl: "http://127.0.0.1/health", stderrTail: "" };
    const stderr = new PassThrough();
    const secret = `synthetic-first-line${"\n".repeat(65)}synthetic-last-line`;
    captureLocalServiceOutput(
      { stderr },
      diagnostics,
      {
        command: "/synthetic/server",
        env: { DIAGNOSTIC_SECRET: secret },
      },
      undefined,
    );
    const lease = createLocalServiceLease(() => {}, diagnostics);
    stderr.write(secret);
    expect(diagnostics.stderrTail).toContain("synthetic-last-line");
    expect(getLocalServiceDiagnosticTail(lease)).not.toContain("synthetic-last-line");
    stderr.end();
  });
});
